/**
 * Model Management — versioning, training orchestration, production promotion.
 * Production model is NEVER replaced automatically.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { prisma, checkDbHealth } from '../database';
import { logger } from '../logging';
import { tradingModel } from '../ai/tradingModel';
import { appendAudit } from '../monitoring/audit';
import { monitoring } from '../monitoring';
import { persistTrainingArtifacts } from '../storage/cloudPersistence';

const PYTHON_DIR = path.join(__dirname, '../../python');
const MODELS_DIR = path.join(PYTHON_DIR, 'saved_models');
const REGISTRY_PATH = path.join(MODELS_DIR, 'registry.json');
const LEARNING_DATASET = path.join(__dirname, '../../data/learning/continuous_dataset.json');
const EXAMPLE_DATASET = path.join(PYTHON_DIR, 'example_training_data.json');

/**
 * Single authoritative python binary resolver. Tries (in order):
 *   1. process.env.PYTHON_PATH (user override)
 *   2. "python3" (Linux/Render default)
 *   3. "python"  (Windows / user PATH)
 * Install script + spawnSync + spawn + python checks MUST all use this to
 * avoid "works in import check, fails on spawn" mismatches that look like
 * "Train on Cloud doesn't work at all" to the user.
 */
function resolvePythonBinary(): string {
  const { spawnSync } = require('child_process');
  const candidates: string[] = [];
  if (process.env.PYTHON_PATH) candidates.push(process.env.PYTHON_PATH);
  candidates.push('python3', 'python');
  for (const bin of candidates) {
    try {
      const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 3000 });
      if (r.status === 0) return bin;
    } catch { /* try next */ }
  }
  return process.env.PYTHON_PATH || 'python3';
}
let __PYTHON_BIN: string | null = null;
const PYTHON_PATH: string = (() => {
  try {
    __PYTHON_BIN = resolvePythonBinary();
  } catch {
    __PYTHON_BIN = process.env.PYTHON_PATH || 'python3';
  }
  return __PYTHON_BIN;
})();

export type TrainingStatus = 'IDLE' | 'RUNNING' | 'COMPLETED' | 'FAILED';

export interface DashboardPayload {
  productionVersion: string | null;
  aiConfidence: number | null;
  trainingStatus: TrainingStatus;
  currentTrainingVersion: string | null;
  models: any[];
  trainingRuns: any[];
  tradeHistory: any[];
  equityCurve: number[];
  drawdown: number;
  riskExposure: number;
  predictionHistory: any[];
  tradeAnalytics: Record<string, number | string>;
  modelPerformance: any;
  postgres: {
    ok: boolean;
    latencyMs: number;
    error?: string;
    host: string | null;
    poolsize?: { max: number };
    tableCounts?: {
      advancedTradeJournals: number;
      modelArtifacts: number;
      trainingRuns: number;
    };
  };
  readOnlyProduction: true;
  cloudMode: boolean;
  trainingDataSource: string | null;
}

let trainingStatus: TrainingStatus = 'IDLE';
let currentTrainingVersion: string | null = null;
let lastTrainingResult: any = null;
let latestConfidence: number | null = null;
let lastTrainingDataSource: string | null = null;
let trainingKickoffPromise: Promise<any> | null = null;
/** Epochs the current/pending run was asked to do. Used for progress est. default 40. */
let trainingEpochCount: number = 40;
/** Wall-clock start of RUNNING training (ms epoch). Compute elapsed + progress est. */
let trainingStartedAt: number | null = null;
/** Observed seconds per epoch from last completed run (Render CPU ~40-120s/epoch). */
let observedEpochSeconds: number | null = null;
/** Last stdout/stderr tail from a RUNNING or just-finished train so stuck UI can show it. */
let trainingOutTail: { stdout: string; stderr: string } | null = null;
/** Hard deadline for current RUNNING train (ms epoch). Abort subprocess + set FAILED when past. */
let trainingDeadlineMs: number | null = null;
/** Kill handle for the current train subprocess (only used by watchdog / reset). */
let activeTrainingProc: any = null;

let pythonCheckCache: any = null;
let pythonCheckCheckedAt = 0;
const PYTHON_CHECK_CACHE_MS = 10 * 60 * 1000; // avoid re-running blocking import checks on every poll

/** Prefer live cloud learning dataset; fall back to bundled example samples. */
export function resolveTrainingDataPath(explicit?: string): string {
  if (explicit && fs.existsSync(explicit)) {
    const size = fs.statSync(explicit).size;
    if (size <= 8 * 1024 * 1024) return explicit;
  }

  if (fs.existsSync(LEARNING_DATASET)) {
    try {
      const stat = fs.statSync(LEARNING_DATASET);
      if (stat.size > 8 * 1024 * 1024) {
        return EXAMPLE_DATASET;
      }
      const raw = JSON.parse(fs.readFileSync(LEARNING_DATASET, 'utf8'));
      const samples = Array.isArray(raw) ? raw : raw?.samples;
      if (Array.isArray(samples) && samples.length >= 5) return LEARNING_DATASET;
    } catch {
      // fall through
    }
  }
  return EXAMPLE_DATASET;
}

const fsPromises = fs.promises;
let trainingDataPathCache: string | null = null;
let trainingDataPathCheckedAt = 0;
const TRAINING_DATA_CACHE_MS = 30 * 1000;

/** Non-blocking async counterpart — use this in HTTP handlers to avoid stalling the event loop. */
export async function resolveTrainingDataPathAsync(explicit?: string): Promise<string> {
  const now = Date.now();
  if (!explicit && trainingDataPathCache && now - trainingDataPathCheckedAt < TRAINING_DATA_CACHE_MS) {
    return trainingDataPathCache;
  }
  if (explicit) {
    try {
      const stat = await fsPromises.stat(explicit);
      if (stat.size <= 8 * 1024 * 1024) return explicit;
    } catch { /* fall through */ }
  }
  let result = EXAMPLE_DATASET;
  try {
    const stat = await fsPromises.stat(LEARNING_DATASET);
    if (stat.size <= 8 * 1024 * 1024) {
      const raw = await fsPromises.readFile(LEARNING_DATASET, 'utf8');
      const parsed = JSON.parse(raw);
      const samples = Array.isArray(parsed) ? parsed : parsed?.samples;
      if (Array.isArray(samples) && samples.length >= 5) result = LEARNING_DATASET;
    }
  } catch { /* fall through to bundled example */ }
  trainingDataPathCache = result;
  trainingDataPathCheckedAt = now;
  return result;
}

function runPython(args: string[], timeoutMs = 600000): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const proc = spawn(PYTHON_PATH, args, { cwd: PYTHON_DIR });
    activeTrainingProc = proc;
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      try { setTimeout(() => proc.kill('SIGKILL'), 5000); } catch { /* ignore */ }
      resolve({ stdout, stderr: stderr + '\nTIMEOUT', code: -1 });
    }, timeoutMs);

    const tail = () => {
      trainingOutTail = {
        stdout: stdout.slice(-2000),
        stderr: stderr.slice(-2000),
      };
    };
    proc.stdout?.on('data', (d) => { stdout += d.toString(); tail(); });
    proc.stderr?.on('data', (d) => { stderr += d.toString(); tail(); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      tail();
      if (activeTrainingProc === proc) activeTrainingProc = null;
      resolve({ stdout, stderr, code });
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      stderr += `\nSPAWN_ERROR ${String(e)}`;
      tail();
      if (activeTrainingProc === proc) activeTrainingProc = null;
      resolve({ stdout, stderr, code: -2 });
    });
  });
}

function parseLastJson(output: string): any {
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // continue
    }
  }
  throw new Error(`No JSON in python output: ${output.slice(-500)}`);
}

function readRegistryFile(): any {
  if (!fs.existsSync(REGISTRY_PATH)) {
    return { production_version: null, candidates: {}, training_runs: [] };
  }
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
}

function buildEquityFromTrades(trades: { profitDollars?: number; profit?: number; pnl?: number }[]): {
  equityCurve: number[];
  drawdown: number;
} {
  let equity = 10000;
  const curve = [equity];
  let peak = equity;
  let maxDd = 0;
  for (const t of trades) {
    const pnl = Number(t.profitDollars ?? t.profit ?? t.pnl ?? 0);
    equity += pnl;
    curve.push(equity);
    peak = Math.max(peak, equity);
    if (peak > 0) maxDd = Math.max(maxDd, (peak - equity) / peak);
  }
  return { equityCurve: curve, drawdown: maxDd };
}

function computeTradeAnalytics(trades: any[]) {
  const closed = trades.filter((t) => t.outcome !== 'OPEN');
  const wins = closed.filter((t) => Number(t.profitDollars ?? t.profitPips ?? 0) > 0 || t.outcome === 'WIN');
  const losses = closed.filter((t) => Number(t.profitDollars ?? t.profitPips ?? 0) < 0 || t.outcome === 'LOSS');
  const grossWin = wins.reduce((s, t) => s + Math.abs(Number(t.profitDollars ?? t.profitPips ?? 0)), 0);
  const grossLoss = losses.reduce((s, t) => s + Math.abs(Number(t.profitDollars ?? t.profitPips ?? 0)), 0);
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  return {
    trades: closed.length,
    winRate: closed.length ? wins.length / closed.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0,
    averageRr: avgLoss > 0 ? avgWin / avgLoss : 0,
    totalPnl: closed.reduce((s, t) => s + Number(t.profitDollars ?? 0), 0),
  };
}

export class ModelManager {
  /**
   * Start training from the cloud learning dataset (or explicit path).
   * Saves candidates with new versions. Never promotes to production.
   * Prefer enqueueTraining() from HTTP handlers so Render/mobile do not time out.
   */
  async startTraining(options: {
    dataPath?: string;
    version?: string;
    epochs?: number;
  } = {}): Promise<any> {
    if (trainingStatus === 'RUNNING') {
      return { success: false, error: 'Training already in progress', status: trainingStatus };
    }

    const dataPath = options.dataPath && fs.existsSync(options.dataPath)
      ? options.dataPath
      : resolveTrainingDataPath(options.dataPath);
    lastTrainingDataSource = dataPath;
    const version = options.version;
    const requestedEpochs = Number(options.epochs ?? process.env.CL_TRAIN_EPOCHS ?? process.env.TRAIN_EPOCHS ?? 40);
    const epochs = Number.isFinite(requestedEpochs) ? Math.min(Math.max(requestedEpochs, 5), 200) : 40;

    trainingStatus = 'RUNNING';
    currentTrainingVersion = version || 'pending';
    lastTrainingResult = null;
    trainingOutTail = null;
    trainingEpochCount = epochs;
    trainingStartedAt = Date.now();
    const baselineSec = observedEpochSeconds ?? 90; // 90s/ep default on Render CPU
    const expectedTotalSec = epochs * baselineSec;
    // Hard cap: use 2× the estimate OR 15 minutes, whichever is larger — prevents 99%
    // forever for slow trains while keeping short-train safety net.
    const deadlineMs = Math.max(900_000, expectedTotalSec * 2 * 1000);
    trainingDeadlineMs = trainingStartedAt + deadlineMs;
    // Reset any previously-stuck proc handle (shouldn't exist).
    activeTrainingProc = null;
    appendAudit('TRAINING', 'STARTED', {
      dataPath,
      version,
      epochs,
      cloud: process.env.NODE_ENV === 'production',
      source: dataPath.includes('continuous_dataset') ? 'cloud_learning' : 'bundled_example',
    });

    const args = [path.join(PYTHON_DIR, 'train.py'), dataPath];
    if (version) args.push(version);
    args.push('--epochs', String(epochs));

    try {
      const { stdout, stderr, code } = await runPython(args, deadlineMs);
      const endAt = Date.now();
      const ranForSeconds = trainingStartedAt ? Math.max(1, Math.floor((endAt - trainingStartedAt) / 1000)) : 0;
      if (ranForSeconds && epochs > 0) {
        observedEpochSeconds = Math.min(600, Math.max(5, Math.round(ranForSeconds / epochs)));
      }
      if (code !== 0) {
        trainingStatus = 'FAILED';
        const tail = trainingOutTail || { stdout: '', stderr: '' };
        lastTrainingResult = {
          success: false,
          error:
            (String(stderr || '').slice(-2000)) ||
            (String(stdout || '').slice(-2000)) ||
            `Python process exited with code ${code}`,
          code,
          stdoutTail: tail.stdout,
          stderrTail: tail.stderr,
          auto_promoted: false,
        };
        await this.persistTrainingFailure(lastTrainingResult.error + '\nstdout:\n' + tail.stdout + '\nstderr:\n' + tail.stderr);
        return lastTrainingResult;
      }

      let result: any;
      try {
        result = parseLastJson(stdout);
      } catch (e) {
        const tail = trainingOutTail || { stdout, stderr };
        trainingStatus = 'FAILED';
        lastTrainingResult = {
          success: false,
          error: `Python finished with no JSON output. ${String(e)}`,
          stdoutTail: tail.stdout.slice(-2000),
          stderrTail: tail.stderr.slice(-2000),
          auto_promoted: false,
        };
        await this.persistTrainingFailure(lastTrainingResult.error + '\nstdout:\n' + lastTrainingResult.stdoutTail + '\nstderr:\n' + lastTrainingResult.stderrTail);
        return lastTrainingResult;
      }
      lastTrainingResult = result;
      trainingStatus = result.success ? 'COMPLETED' : 'FAILED';
      currentTrainingVersion =
        result.best_candidate?.version ||
        result.candidates?.[0]?.version ||
        version ||
        null;

      if (result.success && currentTrainingVersion) {
        const persisted = await persistTrainingArtifacts(currentTrainingVersion);
        logger.info(`[CloudPersistence] Training complete: persisted ${persisted} new artifacts to DB (version=${currentTrainingVersion})`);
      }

      await this.syncRegistryToDb();
      appendAudit(
        'TRAINING',
        result.success ? 'COMPLETED' : 'FAILED',
        {
          best: result.best_candidate?.version,
          recommendation: result.best_candidate?.deployment_recommendation,
          auto_promoted: false,
          dataSource: lastTrainingDataSource,
          ranForSeconds,
          observedEpochSeconds,
        },
        currentTrainingVersion || undefined
      );
      return {
        ...result,
        auto_promoted: false,
        dataSource: lastTrainingDataSource,
        ranForSeconds,
        observedEpochSeconds,
        message:
          result.message ||
          'Training complete. Production model was NOT replaced automatically. Promote from the app when ready.',
      };
    } catch (error) {
      const tail = trainingOutTail || { stdout: '', stderr: '' };
      trainingStatus = 'FAILED';
      lastTrainingResult = {
        success: false,
        error: String(error),
        stdoutTail: tail.stdout,
        stderrTail: tail.stderr,
        auto_promoted: false,
      };
      return lastTrainingResult;
    } finally {
      trainingKickoffPromise = null;
      trainingDeadlineMs = null;
    }
  }

  /**
   * Hard-reset a stuck RUNNING training state. Kills subprocess, clears progress state,
   * and writes lastResult so the UI can show what was interrupted. Safe to call from
   * client /reset button whenever progress has been pinned at 99% for longer than
   * the user is willing to wait (even if we only get here via status poll, the
   * watchdog below auto-calls this at deadline for hands-off safety).
   */
  resetTraining(reason: string = 'User canceled or stale RUNNING watchdog expired'): { ok: boolean } {
    try { if (activeTrainingProc && typeof activeTrainingProc.kill === 'function') activeTrainingProc.kill('SIGKILL'); } catch { /* ignore */ }
    activeTrainingProc = null;
    const tail = trainingOutTail || { stdout: '', stderr: '' };
    trainingStatus = 'FAILED';
    lastTrainingResult = {
      success: false,
      error: reason,
      stdoutTail: tail.stdout,
      stderrTail: tail.stderr,
      auto_promoted: false,
    };
    trainingDeadlineMs = null;
    trainingKickoffPromise = null;
    appendAudit('TRAINING', 'RESET', { reason });
    return { ok: true };
  }

  /**
   * Cloud/mobile-safe entry: accept the job and run training in the background.
   * Clients poll GET /ai/training/status until COMPLETED/FAILED.
   *
   * This MUST never block the event loop or wait on any I/O before returning
   * to the HTTP handler. Sync FS/Python work at enqueue-time was starving
   * socket.io ping/pongs on Render, so the app would see every concurrent
   * request (heartbeats, dashboard loads, orders) fail with a network error
   * the moment Train on Cloud was tapped.
   */
  enqueueTraining(options: {
    dataPath?: string;
    version?: string;
    epochs?: number;
  } = {}): { accepted: boolean; status: TrainingStatus; error?: string; dataSource?: string } {
    if (trainingStatus === 'RUNNING') {
      return { accepted: false, status: trainingStatus, error: 'Training already in progress' };
    }
    trainingStatus = 'RUNNING';
    currentTrainingVersion = options.version || 'pending';
    const requestedEpochs = Number(options.epochs ?? process.env.CL_TRAIN_EPOCHS ?? process.env.TRAIN_EPOCHS ?? 40);
    trainingEpochCount = Number.isFinite(requestedEpochs) ? Math.min(Math.max(requestedEpochs, 5), 200) : 40;
    trainingStartedAt = Date.now();
    const self = this;
    setImmediate(() => {
      resolveTrainingDataPathAsync(options.dataPath)
        .then((dataSource) => {
          lastTrainingDataSource = dataSource;
          trainingKickoffPromise = self
            .startTraining({
              ...options,
              dataPath: dataSource,
            })
            .catch((e) => {
              trainingStatus = 'FAILED';
              lastTrainingResult = { success: false, error: String(e), auto_promoted: false };
              logger.error('Background training failed', e);
              return lastTrainingResult;
            });
        })
        .catch((e) => {
          trainingStatus = 'FAILED';
          lastTrainingResult = {
            success: false,
            error: `Resolve data path failed: ${e}`,
            auto_promoted: false,
          };
          logger.error('Background training data-path resolve failed', e);
        });
    });
    return {
      accepted: true,
      status: 'RUNNING',
      dataSource: lastTrainingDataSource || LEARNING_DATASET,
    };
  }

  async persistTrainingFailure(message: string) {
    try {
      await prisma.trainingRun.create({
        data: {
          version: currentTrainingVersion || 'unknown',
          status: 'FAILED',
          errorMessage: message.slice(0, 2000),
          completedAt: new Date(),
        },
      });
    } catch (e) {
      logger.error('Failed to persist training failure', e);
    }
  }

  /** Sync file registry → Prisma (best-effort). */
  async syncRegistryToDb(): Promise<void> {
    try {
      const reg = readRegistryFile();
      const prod = reg.production_version as string | null;

      await prisma.modelRegistry.upsert({
        where: { id: await this.getRegistryRowId() },
        update: { productionVersion: prod },
        create: { productionVersion: prod },
      });

      for (const [version, entry] of Object.entries(reg.candidates || {}) as [string, any][]) {
        const m = entry.metrics || {};
        await prisma.modelCandidate.upsert({
          where: { version },
          update: {
            winRate: m.win_rate ?? 0,
            profitFactor: m.profit_factor ?? 0,
            avgProfit: m.avg_pnl ?? 0,
            avgRr: m.average_rr ?? null,
            sharpeRatio: m.sharpe_ratio ?? 0,
            maxDrawdown: m.max_drawdown ?? null,
            accuracy: m.accuracy ?? null,
            precision: m.precision ?? null,
            recall: m.recall ?? null,
            f1Score: m.f1 ?? null,
            trainingLoss: m.training_loss ?? null,
            validationLoss: m.validation_loss ?? null,
            tradeFrequency: m.trade_frequency ?? null,
            stability: m.stability ?? null,
            status: entry.status || 'CANDIDATE',
            deploymentRec: entry.deployment_recommendation || 'NO',
            recReason: entry.recommendation_reason || '',
            isProduction: version === prod,
            metricsJson: m,
            trainingDate: entry.registered_at ? new Date(entry.registered_at) : new Date(),
          },
          create: {
            version,
            trainingDate: entry.registered_at ? new Date(entry.registered_at) : new Date(),
            winRate: m.win_rate ?? 0,
            profitFactor: m.profit_factor ?? 0,
            avgProfit: m.avg_pnl ?? 0,
            avgRr: m.average_rr ?? null,
            sharpeRatio: m.sharpe_ratio ?? 0,
            maxDrawdown: m.max_drawdown ?? null,
            accuracy: m.accuracy ?? null,
            precision: m.precision ?? null,
            recall: m.recall ?? null,
            f1Score: m.f1 ?? null,
            trainingLoss: m.training_loss ?? null,
            validationLoss: m.validation_loss ?? null,
            tradeFrequency: m.trade_frequency ?? null,
            stability: m.stability ?? null,
            status: entry.status || 'CANDIDATE',
            deploymentRec: entry.deployment_recommendation || 'NO',
            recReason: entry.recommendation_reason || '',
            isProduction: version === prod,
            metricsJson: m,
          },
        });
      }

      // Training runs stay file-backed; DB rows are written at train completion only.
    } catch (e) {
      logger.error('Registry sync skipped (DB unavailable?)', e);
    }
  }

  private async getRegistryRowId(): Promise<string> {
    const existing = await prisma.modelRegistry.findFirst();
    if (existing) return existing.id;
    const created = await prisma.modelRegistry.create({ data: {} });
    return created.id;
  }

  getProductionVersion(): string | null {
    const reg = readRegistryFile();
    return reg.production_version || null;
  }

  /**
   * Explicit promote only — never called by training automatically.
   * Dual-writes registry + production weights to Postgres so Render restarts keep the model.
   */
  async promoteCandidate(version: string): Promise<any> {
    appendAudit('PROMOTION', 'REQUESTED', { version, cloud: process.env.NODE_ENV === 'production' }, version);
    const { stdout, stderr, code } = await runPython([
      path.join(PYTHON_DIR, 'manage.py'),
      'promote',
      version,
    ]);
    if (code !== 0) {
      appendAudit('PROMOTION', 'FAILED', { error: stderr || stdout }, version);
      return { success: false, error: stderr || stdout };
    }
    const result = parseLastJson(stdout);
    await this.syncRegistryToDb();
    const persisted = await persistTrainingArtifacts(version);
    logger.info(`[CloudPersistence] Promote ${version}: persisted ${persisted} artifacts to DB`);
    appendAudit('PROMOTION', 'COMPLETED', { ...result, persisted }, version, 'manual');
    return {
      ...result,
      success: result.success !== false,
      persisted,
      message: result.message || `${version} promoted to production (persisted to cloud DB).`,
    };
  }

  async logPrediction(prediction: any, symbol?: string, features?: number[]) {
    const probs = [
      prediction.buy_probability,
      prediction.sell_probability,
      prediction.hold_probability,
    ];
    const actions = ['BUY', 'SELL', 'HOLD'] as const;
    const predictedAction = actions[probs.indexOf(Math.max(...probs))];
    latestConfidence = Number(prediction.confidence);

    try {
      await prisma.predictionLog.create({
        data: {
          modelVersion: this.getProductionVersion() || 'unknown',
          symbol: symbol || null,
          buyProbability: prediction.buy_probability,
          sellProbability: prediction.sell_probability,
          holdProbability: prediction.hold_probability,
          confidence: prediction.confidence,
          expectedRisk: prediction.expected_risk ?? null,
          expectedReward: prediction.expected_reward ?? null,
          expectedDuration: prediction.expected_duration ?? null,
          predictedAction,
          featuresSnapshot: features ? features.slice(0, 50) : undefined,
        },
      });
    } catch (e) {
      logger.error('Failed to log prediction', e);
    }

    return { ...prediction, predictedAction, modelVersion: this.getProductionVersion() };
  }

  async predictWithProduction(features: number[], symbol?: string) {
    const version = this.getProductionVersion() || 'v1.1';
    const prediction = await monitoring.timeAsync(
      'inference',
      () => tradingModel.predict(features, version),
      'predict'
    );
    return this.logPrediction(prediction, symbol, features);
  }

  getTrainingStatus() {
    // --- WATCHDOG: auto-reset a RUNNING job that has exceeded its deadline.
    // Prevents the "stuck 99% for 30 min" UX disaster when subprocess hangs
    // or timer inside child_process Promise.resolve never fires (SIGTERM lost).
    if (trainingStatus === 'RUNNING' && trainingDeadlineMs && Date.now() > trainingDeadlineMs) {
      this.resetTraining(
        `Training watchdog expired after ${Math.floor((trainingDeadlineMs - (trainingStartedAt || trainingDeadlineMs)) / 1000)}s; subprocess killed automatically`
      );
    }
    const elapsedSec = trainingStatus === 'RUNNING' && trainingStartedAt
      ? Math.max(0, Math.floor((Date.now() - trainingStartedAt) / 1000))
      : 0;
    // Heuristic progress: use observed epoch time if available, else use 60s/epoch Render CPU default,
    // else fall back to time-based 0-5% gentle ramp while training is spinning up (import numpy/torch).
    const baselineEpochSec = observedEpochSeconds ?? 90; // bumped to 90 — better match slow Render CPU
    const totalExpectedSec = trainingEpochCount * baselineEpochSec;
    let progressPct = 0;
    if (trainingStatus === 'COMPLETED') {
      progressPct = 1;
    } else if (trainingStatus === 'FAILED') {
      progressPct = Math.min(0.99, elapsedSec / Math.max(totalExpectedSec, 60));
    } else if (trainingStatus === 'RUNNING') {
      const expected = Math.max(totalExpectedSec, 30);
      // Progress ramp toward soft cap 0.98, never actually shows 100 until COMPLETED
      // (avoids "99% for 30 min" when estimate underruns by a little bit — instead
      // the bar will grow slowly toward 98% and the elapsed counter keeps climbing
      // until deadline kills it.)
      const raw = elapsedSec / expected;
      const softCap = 0.98;
      if (raw >= 1) {
        // Over estimate: grow toward 0.98 logarithmically so bar never sits flat.
        const over = 1 + Math.log10(Math.max(1.01, raw));
        progressPct = Math.min(0.989, 0.92 + 0.069 * Math.min(1, (over - 1) / (over + 3)));
      } else {
        progressPct = Math.max(0.02, raw * softCap);
      }
    }
    const remainingSec = trainingStatus === 'RUNNING'
      ? Math.max(0, totalExpectedSec - elapsedSec)
      : 0;
    const tail = trainingOutTail;
    const lr = lastTrainingResult;
    return {
      status: trainingStatus,
      currentVersion: currentTrainingVersion,
      dataSource: lastTrainingDataSource,
      cloudMode: process.env.NODE_ENV === 'production',
      progress: {
        progressPct: Number(progressPct.toFixed(3)),
        elapsedSec,
        remainingSec,
        epochsTotal: trainingEpochCount,
        epochSecondsEstimate: baselineEpochSec,
        deadlineSec: trainingDeadlineMs && trainingStartedAt
          ? Math.max(0, Math.floor((trainingDeadlineMs - trainingStartedAt) / 1000))
          : 0,
        deadlineLeftSec: trainingDeadlineMs
          ? Math.max(0, Math.floor((trainingDeadlineMs - Date.now()) / 1000))
          : 0,
      },
      stdoutTail: tail?.stdout ?? lr?.stdoutTail ?? null,
      stderrTail: tail?.stderr ?? lr?.stderrTail ?? null,
      bestCandidate: lastTrainingResult?.best_candidate
        ? {
            version: lastTrainingResult.best_candidate.version,
            deployment_recommendation: lastTrainingResult.best_candidate.deployment_recommendation,
            recommendation_reason: lastTrainingResult.best_candidate.recommendation_reason,
            metrics: lastTrainingResult.best_candidate.evaluation || lastTrainingResult.best_candidate.metrics || null,
          }
        : null,
      lastResult: lastTrainingResult
        ? {
            success: lastTrainingResult.success,
            best_candidate: lastTrainingResult.best_candidate?.version,
            deployment_recommendation:
              lastTrainingResult.best_candidate?.deployment_recommendation,
            auto_promoted: false,
            message: lastTrainingResult.message,
            error: lastTrainingResult.error,
            code: lastTrainingResult.code,
            stdoutTail: lastTrainingResult.stdoutTail,
            stderrTail: lastTrainingResult.stderrTail,
          }
        : null,
      readOnlyProduction: true as const,
    };
  }

  /**
   * Async non-blocking python check. Runs once, caches for 10 minutes. If stale
   * cache is available, it returns stale immediately and refreshes in the
   * background. Never blocks the event loop with sync spawnSync.
   */
  async getPythonCheckAsync(): Promise<{
    available: boolean; version: string | null; depsOk: boolean; out: string | null;
  }> {
    const now = Date.now();
    if (pythonCheckCache && now - pythonCheckCheckedAt < PYTHON_CHECK_CACHE_MS) {
      return pythonCheckCache;
    }
    const cachedForReturn = pythonCheckCache;
    const run = async () => {
      try {
        const { stdout, stderr, code } = await runPython([
          '-c',
          'import sys, json\ntry:\n import numpy, torch\n print(json.dumps({"ok": True, "numpy": numpy.__version__, "torch": torch.__version__}))\nexcept Exception as e:\n print(json.dumps({"ok": False, "err": str(e)}))',
        ], 15000);
        let out: string | null = null;
        let available = false;
        let version: string | null = null;
        let depsOk = false;
        if (code === 0 && stdout) {
          available = true;
          version = (stdout || '').split('\n')[0] || null;
          try {
            const j = JSON.parse((stdout || '').trim().split(/\r?\n/).slice(-1)[0]);
            depsOk = !!j.ok;
            out = JSON.stringify(j);
          } catch (_e) {
            out = (stdout || stderr || '').slice(0, 1000);
          }
        } else {
          out = (stderr || stdout || '').slice(0, 1000);
        }
        return { available, version, depsOk, out };
      } catch (e: any) {
        return { available: false, version: null, depsOk: false, out: String(e).slice(0, 1000) };
      }
    };
    const refresh = run().then((r) => {
      pythonCheckCache = r;
      pythonCheckCheckedAt = Date.now();
      return r;
    }).catch(() => {
      pythonCheckCache = cachedForReturn || { available: false, version: null, depsOk: false, out: null };
      pythonCheckCheckedAt = Date.now();
      return pythonCheckCache;
    });
    if (cachedForReturn) return cachedForReturn;
    return refresh;
  }

  /**
   * Diagnostics helper used by the API to return clearer training/backtest failure reasons.
   * Does not expose secrets. Python check is cached and non-blocking; sync callers
   * get the cached version and the check refreshes in the background when stale.
   */
  getDiagnostics() {
    // Kick off non-blocking refresh when stale so next poll has fresh data.
    const now = Date.now();
    if (!pythonCheckCache || now - pythonCheckCheckedAt >= PYTHON_CHECK_CACHE_MS) {
      this.getPythonCheckAsync().catch(() => {});
    }
    const pythonCheck = pythonCheckCache || {
      available: false,
      version: null as string | null,
      depsOk: false,
      out: null as string | null,
    };

    return {
      trainingStatus,
      lastTrainingResult: lastTrainingResult ? { success: !!lastTrainingResult.success, error: lastTrainingResult.error || null, message: lastTrainingResult.message || null } : null,
      lastTrainingDataSource,
      pythonCheck,
      cloudMode: process.env.NODE_ENV === 'production',
    };
  }

  async getDashboard(): Promise<DashboardPayload> {
    const reg = readRegistryFile();
    let tradeHistory: any[] = [];
    let predictionHistory: any[] = [];

    try {
      tradeHistory = await prisma.advancedTradeJournal.findMany({
        where: { outcome: { in: ['WIN', 'LOSS', 'BREAKEVEN'] } },
        orderBy: [{ closeTimestamp: 'desc' }, { updatedAt: 'desc' }],
        take: 100,
      });
    } catch {
      tradeHistory = [];
    }

    try {
      predictionHistory = await prisma.predictionLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
    } catch {
      predictionHistory = [];
    }

    if (predictionHistory.length && latestConfidence == null) {
      latestConfidence = Number(predictionHistory[0].confidence);
    }

    const { equityCurve, drawdown } = buildEquityFromTrades(
      [...tradeHistory].reverse().map((t) => ({
        profitDollars: Number(t.profitDollars ?? 0),
      }))
    );

    let learningDatasetSamples = 0;
    try {
      const dsPath = lastTrainingDataSource && fs.existsSync(lastTrainingDataSource)
        ? lastTrainingDataSource
        : LEARNING_DATASET;
      if (fs.existsSync(dsPath)) {
        const raw = JSON.parse(fs.readFileSync(dsPath, 'utf8'));
        const samples = Array.isArray(raw) ? raw : raw?.samples;
        learningDatasetSamples = Array.isArray(samples) ? samples.length : 0;
      }
    } catch { /* fallback to zero */ }

    const analytics = computeTradeAnalytics(tradeHistory);
    const prod = reg.production_version;
    const prodEntry = prod ? reg.candidates?.[prod] : null;
    const models = Object.values(reg.candidates || {}).map((m: any) => ({
      ...m,
      is_production: m.version === prod,
      editable: m.version !== prod,
    }));

    return {
      productionVersion: prod,
      aiConfidence: latestConfidence,
      trainingStatus,
      currentTrainingVersion,
      models,
      trainingRuns: [...(reg.training_runs || [])].reverse().slice(0, 20),
      tradeHistory: tradeHistory.slice(0, 40).map((t) => ({
        ticket: t.ticket,
        symbol: t.symbol,
        direction: t.direction,
        outcome: t.outcome,
        profitPips: Number(t.profitPips),
        profitDollars: Number(t.profitDollars),
        aiConfidence: t.aiConfidence != null ? Number(t.aiConfidence) : null,
        modelVersion: t.modelVersion,
        entryTimestamp: t.entryTimestamp,
      })),
      equityCurve,
      drawdown,
      // NOTE: Trade-history above intentionally excludes OPEN, so there is no
      // "open risk" from the trade-history set. If live open-position watches
      // exist we surface that separately through learning.liveWatch.openTrades.
      riskExposure: 0,
      predictionHistory: predictionHistory.map((p) => ({
        id: p.id,
        modelVersion: p.modelVersion,
        symbol: p.symbol,
        predictedAction: p.predictedAction,
        confidence: Number(p.confidence),
        buyProbability: Number(p.buyProbability),
        sellProbability: Number(p.sellProbability),
        holdProbability: Number(p.holdProbability),
        createdAt: p.createdAt,
      })),
      tradeAnalytics: {
        ...analytics,
        // Extra: surface dataset sample count to AI Lab. User taps Train on Cloud and
        // sees "0 samples → need more trades" instantly instead of waiting for fail.
        learningDatasetSamples,
      },
      modelPerformance: {
        production: prodEntry?.metrics || null,
        candidates: models.filter((m: any) => !m.is_production).slice(0, 5),
        lastTraining: lastTrainingResult?.best_candidate?.evaluation || null,
      },
      postgres: await Promise.race([
        checkDbHealth(),
        new Promise<{ ok: boolean; latencyMs: number; error: string; host: null }>((resolve) =>
          setTimeout(() => resolve({ ok: false, latencyMs: 500, error: 'db check took too long', host: null }), 500)
        ),
      ]).catch((e) => ({ ok: false, latencyMs: 0, error: String(e), host: null })),
      readOnlyProduction: true,
      cloudMode: process.env.NODE_ENV === 'production',
      trainingDataSource: lastTrainingDataSource,
    };
  }
}

export const modelManager = new ModelManager();
