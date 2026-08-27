/**
 * Model Management — versioning, training orchestration, production promotion.
 * Production model is NEVER replaced automatically.
 */

import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { prisma } from '../database';
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
const PYTHON_PATH = process.env.PYTHON_PATH || 'python';

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
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      resolve({ stdout, stderr: stderr + '\nTIMEOUT', code: -1 });
    }, timeoutMs);

    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
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

    const dataPath = resolveTrainingDataPath(options.dataPath);
    lastTrainingDataSource = dataPath;
    const version = options.version;
    const requestedEpochs = Number(options.epochs ?? process.env.CL_TRAIN_EPOCHS ?? process.env.TRAIN_EPOCHS ?? 20);
    const epochs = Number.isFinite(requestedEpochs) ? Math.min(Math.max(requestedEpochs, 5), 30) : 20;

    trainingStatus = 'RUNNING';
    currentTrainingVersion = version || 'pending';
    lastTrainingResult = null;
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
      const { stdout, stderr, code } = await runPython(args, 900000);
      if (code !== 0) {
        trainingStatus = 'FAILED';
        lastTrainingResult = { success: false, error: stderr || stdout, auto_promoted: false };
        await this.persistTrainingFailure(stderr || stdout);
        return lastTrainingResult;
      }

      const result = parseLastJson(stdout);
      lastTrainingResult = result;
      trainingStatus = result.success ? 'COMPLETED' : 'FAILED';
      currentTrainingVersion =
        result.best_candidate?.version ||
        result.candidates?.[0]?.version ||
        version ||
        null;

      // --- CLOUD PERSIST: push new candidate model + scalers + updated registry to DB blobs ---
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
        },
        currentTrainingVersion || undefined
      );
      return {
        ...result,
        auto_promoted: false,
        dataSource: lastTrainingDataSource,
        message:
          result.message ||
          'Training complete. Production model was NOT replaced automatically. Promote from the app when ready.',
      };
    } catch (error) {
      trainingStatus = 'FAILED';
      lastTrainingResult = { success: false, error: String(error), auto_promoted: false };
      return lastTrainingResult;
    } finally {
      trainingKickoffPromise = null;
    }
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
    const acceptedAt = Date.now();
    setImmediate(() => {
      resolveTrainingDataPathAsync(options.dataPath)
        .then((dataSource) => {
          lastTrainingDataSource = dataSource;
          trainingKickoffPromise = this.startTraining({
            ...options,
            dataPath: dataSource,
          }).catch((e) => {
            trainingStatus = 'FAILED';
            lastTrainingResult = { success: false, error: String(e), auto_promoted: false };
            logger.error('Background training failed', e);
            return lastTrainingResult;
          });
        })
        .catch((e) => {
          trainingStatus = 'FAILED';
          lastTrainingResult = { success: false, error: `Resolve data path failed: ${e}`, auto_promoted: false };
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
    return {
      status: trainingStatus,
      currentVersion: currentTrainingVersion,
      dataSource: lastTrainingDataSource,
      cloudMode: process.env.NODE_ENV === 'production',
      lastResult: lastTrainingResult
        ? {
            success: lastTrainingResult.success,
            best_candidate: lastTrainingResult.best_candidate?.version,
            deployment_recommendation:
              lastTrainingResult.best_candidate?.deployment_recommendation,
            auto_promoted: false,
            message: lastTrainingResult.message,
            error: lastTrainingResult.error,
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
      const python = process.env.PYTHON_PATH || 'python3';
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
      // Trade History in AI Lab is a closed-trade view. OPEN rows belong only
      // to the live watch / continuous learning sections. This prevents a
      // still-open journal row (or pre-close DNA-missing row) from leaking
      // into the "Trade History" card as if it's already completed.
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

    const openRisk = tradeHistory
      .filter((t) => t.outcome === 'OPEN')
      .reduce((s, t) => s + Number(t.riskPercent ?? 0), 0);

    const analytics = computeTradeAnalytics(tradeHistory);
    const prod = reg.production_version;
    const prodEntry = prod ? reg.candidates?.[prod] : null;
    const models = Object.values(reg.candidates || {}).map((m: any) => ({
      ...m,
      is_production: m.version === prod,
      // View-only flag for production in UI
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
      riskExposure: openRisk,
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
      tradeAnalytics: analytics,
      modelPerformance: {
        production: prodEntry?.metrics || null,
        candidates: models.filter((m: any) => !m.is_production).slice(0, 5),
        lastTraining: lastTrainingResult?.best_candidate?.evaluation || null,
      },
      readOnlyProduction: true,
      cloudMode: process.env.NODE_ENV === 'production',
      trainingDataSource: lastTrainingDataSource,
    };
  }
}

export const modelManager = new ModelManager();
