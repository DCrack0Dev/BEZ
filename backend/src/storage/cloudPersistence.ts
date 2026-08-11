/**
 * Cloud Persistence Layer — survives Render / PaaS ephemeral filesystem wipes.
 *
 * Problem: On Render/Railway/Fly/etc the container filesystem is wiped on
 * every deploy or auto-restart. That means saved_models/, saved_scalers/,
 * and data/learning/continuous_dataset.json get lost — training progress,
 * promoted production models, and labeled trade samples all vanish.
 *
 * Solution (dual-write + restore-on-boot):
 *   SAVE  → every file written to disk is ALSO upserted to ModelArtifact (DB BYTEA).
 *   BOOT  → if saved_models/registry.json is missing on disk (cold start) we
 *           RESTORE every artifact from DB to disk before Python scripts run.
 *   SYNC  → POST /api/storage/sync endpoint forces a full FS→DB snapshot (idempotent).
 *
 * This is compatible with — and complementary to — Render Persistent Disks.
 * If a disk is mounted at /app/backend/data + /app/backend/python/saved_* the
 * cold-start restore is a no-op (checksum matches, nothing re-downloaded).
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { prisma } from '../database';
import { logger } from '../logging';
import { appendAudit } from '../monitoring/audit';

const PYTHON_DIR = path.join(__dirname, '../../python');
const DATA_DIR = path.join(__dirname, '../../data');

export const PERSISTED_ROOTS = [
  { root: path.join(PYTHON_DIR, 'saved_models'),  typePrefix: 'MODEL'   },
  { root: path.join(PYTHON_DIR, 'saved_scalers'), typePrefix: 'SCALER'  },
  { root: path.join(DATA_DIR, 'learning'),        typePrefix: 'DATASET' },
  { root: path.join(DATA_DIR, 'audit'),           typePrefix: 'AUDIT_LOG' },
  { root: path.join(DATA_DIR, 'backtest-reports'),typePrefix: 'BACKTEST_REPORT' },
];

// Also persist live observation logs under learning/
// (live_observations.jsonl + live_watch_state.json covered by DATASET walk)

const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024; // 512MB cap per artifact

function sha256Buffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function classify(absPath: string, root: string, typePrefix: string): { artifactKey: string; type: string; version: string | null } {
  const rel = path.relative(root, absPath).split(path.sep).join('/');
  const artifactKey = `${typePrefix.toLowerCase()}:${rel}`;

  let type = `${typePrefix}_MISC`;
  if (typePrefix === 'MODEL') {
    if (rel.endsWith('.pt') || rel.endsWith('.pth')) type = 'MODEL_WEIGHTS';
    else if (rel.endsWith('metadata.json') || rel.endsWith('config.json')) type = 'MODEL_METADATA';
    else if (rel.endsWith('registry.json')) type = 'REGISTRY';
    else type = 'MODEL_METADATA';
  } else if (typePrefix === 'SCALER') {
    type = 'SCALER';
  } else if (typePrefix === 'DATASET') {
    type = 'DATASET';
  } else if (typePrefix === 'AUDIT_LOG') {
    type = 'AUDIT_LOG';
  } else if (typePrefix === 'BACKTEST_REPORT') {
    type = 'BACKTEST_REPORT';
  }

  // Extract version from paths like "model_v1.3/weights.pt" → v1.3
  let version: string | null = null;
  const m = rel.match(/(?:model_)?(v\d+\.\d+)/i);
  if (m) version = m[1];

  return { artifactKey, type, version };
}

// ---------------------------------------------------------------
// WRITE PATH: single file → FS + DB (dual-write)
// ---------------------------------------------------------------
export async function persistFile(absPath: string, root?: string): Promise<{ written: boolean; artifactKey?: string }> {
  try {
    if (!fs.existsSync(absPath)) return { written: false };
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return { written: false };
    if (stat.size > MAX_ARTIFACT_BYTES) {
      logger.warn(`[cloudPersist] Skipping oversized file: ${absPath} (${stat.size} bytes)`);
      return { written: false };
    }

    const buf = fs.readFileSync(absPath);
    const checksum = sha256Buffer(buf);

    // Find matching root entry
    let entry = PERSISTED_ROOTS.find((r) => absPath.startsWith(r.root));
    if (!entry && root) entry = PERSISTED_ROOTS.find((r) => r.root === root);
    if (!entry) return { written: false };

    const { artifactKey, type, version } = classify(absPath, entry.root, entry.typePrefix);
    const mimeType = absPath.endsWith('.json') ? 'application/json'
      : absPath.endsWith('.pt') || absPath.endsWith('.pth') ? 'application/x-pytorch'
      : absPath.endsWith('.joblib') ? 'application/x-joblib'
      : 'application/octet-stream';

    // Skip upsert if DB already has identical checksum (no-op)
    const existing = await prisma.modelArtifact.findUnique({ where: { artifactKey }, select: { checksum: true } });
    if (existing && existing.checksum === checksum) {
      return { written: false, artifactKey };
    }

    await prisma.modelArtifact.upsert({
      where: { artifactKey },
      create: { artifactKey, type, version, data: Buffer.from(buf), sizeBytes: buf.length, checksum, mimeType },
      update: { type, version, data: Buffer.from(buf), sizeBytes: buf.length, checksum, mimeType },
    });
    return { written: true, artifactKey };
  } catch (error) {
    logger.error(`[cloudPersist] persistFile failed for ${absPath}:`, error);
    return { written: false };
  }
}

// ---------------------------------------------------------------
// FULL SNAPSHOT: walk all PERSISTED_ROOTS → DB upsert batch
// ---------------------------------------------------------------
export async function snapshotAllToDb(): Promise<{ files: number; written: number; errors: number }> {
  let files = 0, written = 0, errors = 0;
  for (const { root } of PERSISTED_ROOTS) {
    if (!fs.existsSync(root)) continue;
    const walk = (dir: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) walk(abs);
        else if (e.isFile()) {
          files++;
          persistFile(abs, root).then((r) => { if (r.written) written++; }).catch(() => { errors++; });
        }
      }
    };
    walk(root);
  }
  // Wait for outstanding promises (best-effort — not strictly bounded)
  await new Promise((r) => setTimeout(r, 200));
  appendAudit('LEARNING', 'SNAPSHOT_FS_TO_DB', { files, written, errors }, undefined, 'system');
  logger.info(`[cloudPersist] Snapshot complete: ${files} files, ${written} written to DB, ${errors} errors`);
  return { files, written, errors };
}

// ---------------------------------------------------------------
// BOOT RESTORE: DB → FS. Only runs if FS is cold (registry missing).
// ---------------------------------------------------------------
export async function restoreFromDbIfCold(): Promise<{ restored: number; skipped: number; wasCold: boolean }> {
  const registryMarker = path.join(PYTHON_DIR, 'saved_models', 'registry.json');
  const wasCold = !fs.existsSync(registryMarker);

  if (!wasCold) {
    // Even on warm starts, reconcile DB artifacts that are newer than disk
    // (e.g. training finished on instance A, then deploy to instance B).
  }

  let restored = 0, skipped = 0;
  try {
    const artifacts = await prisma.modelArtifact.findMany();
    for (const art of artifacts) {
      const abs = keyToAbsPath(art.artifactKey);
      if (!abs) { skipped++; continue; }

      const dir = path.dirname(abs);
      fs.mkdirSync(dir, { recursive: true });

      if (fs.existsSync(abs)) {
        const diskSum = sha256Buffer(fs.readFileSync(abs));
        if (diskSum === art.checksum) { skipped++; continue; }
      }
      fs.writeFileSync(abs, Buffer.from(art.data as any as Buffer));
      restored++;
    }
  } catch (error) {
    logger.error('[cloudPersist] restoreFromDbIfCold failed:', error);
  }

  if (restored > 0 || wasCold) {
    appendAudit('LEARNING', 'RESTORE_DB_TO_FS', { restored, skipped, wasCold }, undefined, 'system');
    logger.info(`[cloudPersist] Cold-boot restore: ${restored} files from DB, ${skipped} identical (wasCold=${wasCold})`);
  }
  return { restored, skipped, wasCold };
}

function keyToAbsPath(artifactKey: string): string | null {
  // artifactKey format: "<prefix>:<relative path with / separators>"
  const idx = artifactKey.indexOf(':');
  if (idx < 0) return null;
  const prefix = artifactKey.slice(0, idx).toLowerCase();
  const rel = artifactKey.slice(idx + 1).split('/').join(path.sep);

  const entry = PERSISTED_ROOTS.find((r) => r.typePrefix.toLowerCase() === prefix);
  if (!entry) return null;
  return path.join(entry.root, rel);
}

// ---------------------------------------------------------------
// Hook into the training pipeline: call after every train.py completion
// so the candidate model + new registry are persisted before the process dies.
// ---------------------------------------------------------------
export async function persistTrainingArtifacts(version: string): Promise<number> {
  let written = 0;
  for (const { root } of PERSISTED_ROOTS) {
    if (!fs.existsSync(root)) continue;
    const walk = (dir: string) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) walk(abs);
        else if (e.isFile() && abs.includes(version)) {
          persistFile(abs, root).then((r) => { if (r.written) written++; });
        }
      }
    };
    walk(root);
  }
  // Also push global registry + dataset
  for (const p of [
    path.join(PYTHON_DIR, 'saved_models', 'registry.json'),
    path.join(DATA_DIR, 'learning', 'continuous_dataset.json'),
  ]) {
    const r = await persistFile(p);
    if (r.written) written++;
  }
  await new Promise((res) => setTimeout(res, 200));
  return written;
}
