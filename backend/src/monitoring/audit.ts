/**
 * Append-only audit log for training, evaluation, promotion, backtests, learning.
 */

import fs from 'fs';
import path from 'path';
import { logger } from '../logging';

const AUDIT_DIR = path.join(__dirname, '../../data/audit');
const AUDIT_PATH = path.join(AUDIT_DIR, 'audit.jsonl');

export type AuditCategory =
  | 'TRAINING'
  | 'EVALUATION'
  | 'PROMOTION'
  | 'BACKTEST'
  | 'LEARNING'
  | 'MONITORING'
  | 'DATASET';

export interface AuditEntry {
  id: string;
  category: AuditCategory;
  action: string;
  version?: string;
  details?: Record<string, any>;
  actor: string;
  createdAt: string;
}

function ensureDir() {
  if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
}

export function appendAudit(
  category: AuditCategory,
  action: string,
  details?: Record<string, any>,
  version?: string,
  actor = 'system'
): AuditEntry {
  ensureDir();
  const entry: AuditEntry = {
    id: `audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    category,
    action,
    version,
    details,
    actor,
    createdAt: new Date().toISOString(),
  };
  fs.appendFileSync(AUDIT_PATH, JSON.stringify(entry) + '\n');
  logger.info(`[AUDIT] ${category}/${action}`, { version, id: entry.id });
  return entry;
}

export function readAuditLog(limit = 100, category?: AuditCategory): AuditEntry[] {
  ensureDir();
  if (!fs.existsSync(AUDIT_PATH)) return [];
  const lines = fs.readFileSync(AUDIT_PATH, 'utf-8').trim().split('\n').filter(Boolean);
  const entries: AuditEntry[] = [];
  for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
    try {
      const e = JSON.parse(lines[i]) as AuditEntry;
      if (!category || e.category === category) entries.push(e);
    } catch {
      // skip bad line
    }
  }
  return entries;
}

export function listModelVersionsFromAudit(): string[] {
  const entries = readAuditLog(500);
  const versions = new Set<string>();
  for (const e of entries) {
    if (e.version) versions.add(e.version);
  }
  return [...versions];
}
