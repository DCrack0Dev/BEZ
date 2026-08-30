// API Layer - Handles all HTTP endpoints
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { apiLogger } from '../logging';
import { journalManager } from '../trade-journal';
import { modelManager } from '../model-management';
import { monitoring } from '../monitoring';
import { readAuditLog } from '../monitoring/audit';
import { backtestEngine } from '../backtesting';
import { continuousLearning } from '../continuous-learning';
import { corsOriginCheck } from '../middleware/corsConfig';
import { requireAuth } from '../middleware/auth';
import { userActionLimiter } from '../middleware/rateLimiter';
import { simulationRouter } from '../simulation/routes';
import { liveTradeObserver } from '../analytics/tradeObserver';
import { checkDbHealth } from '../database';

const router = express.Router();

// Apply CORS (explicit allowlist, see middleware/corsConfig.ts) and body parser to router
router.use(cors({ origin: corsOriginCheck, credentials: true }));
router.use(bodyParser.json({ limit: '50mb' }));
router.use(bodyParser.urlencoded({ extended: true }));

// Health check endpoint
router.get('/test', (req, res) => {
  apiLogger.info('Health check requested');
  res.status(200).send('OK');
});

// Root health check — keeps Render / Reverse Proxy probes from logging 404,
// and prevents "warning HTTP 404 /" spamming when the app opens AI Lab on
// a fresh base URL navigation.
router.get('/', async (_req, res) => {
  let db: any = null;
  let statusLabel: 'UP' | 'DEGRADED' | 'DOWN' = 'UP';
  let http = 200;
  try {
    const race = await Promise.race([
      checkDbHealth(),
      new Promise<{ ok: false; latencyMs: number; error: string }>((resolve) =>
        setTimeout(() => resolve({ ok: false, latencyMs: 3000, error: 'timeout' }), 3000)
      ),
    ]) as any;
    db = race;
    if (!race.ok) {
      statusLabel = 'DOWN';
      http = 503;
    } else if ((race.latencyMs ?? 0) > 1500) {
      statusLabel = 'DEGRADED';
      http = 200;
    }
  } catch (e: any) {
    db = { ok: false, error: String(e) };
    statusLabel = 'DOWN';
    http = 503;
  }
  res.status(http).json({
    success: statusLabel !== 'DOWN',
    service: 'LiquiBot Backend',
    status: statusLabel,
    version: '4.0.0',
    time: new Date().toISOString(),
    postgres: db,
  });
});
router.get('/health', async (_req, res) => {
  let db: any = null;
  let statusLabel: 'UP' | 'DEGRADED' | 'DOWN' = 'UP';
  let http = 200;
  try {
    const race = await Promise.race([
      checkDbHealth(),
      new Promise<{ ok: false; latencyMs: number; error: string }>((resolve) =>
        setTimeout(() => resolve({ ok: false, latencyMs: 3000, error: 'timeout' }), 3000)
      ),
    ]) as any;
    db = race;
    if (!race.ok) {
      statusLabel = 'DOWN';
      http = 503;
    } else if ((race.latencyMs ?? 0) > 1500) {
      statusLabel = 'DEGRADED';
      http = 200;
    }
  } catch (e: any) {
    db = { ok: false, error: String(e) };
    statusLabel = 'DOWN';
    http = 503;
  }
  res.status(http).json({
    success: statusLabel !== 'DOWN',
    service: 'LiquiBot Backend',
    status: statusLabel,
    version: '4.0.0',
    time: new Date().toISOString(),
    postgres: db,
  });
});
router.head('/', (_req, res) => {
  res.status(200).end();
});
router.head('/health', (_req, res) => {
  res.status(200).end();
});

// --- Advanced Trade Journal API ---
router.get('/journal', async (req, res) => {
  try {
    const { symbol, outcome, startDate, endDate, limit, offset } = req.query;
    const entries = await journalManager.getAllEntries({
      symbol: symbol as string,
      outcome: outcome as string,
      startDate: startDate ? new Date(startDate as string) : undefined,
      endDate: endDate ? new Date(endDate as string) : undefined,
      limit: limit ? parseInt(limit as string) : undefined,
      offset: offset ? parseInt(offset as string) : undefined,
    });
    res.json({ success: true, data: entries });
  } catch (error) {
    apiLogger.error(`Failed to get journal entries: ${error}`);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.get('/journal/:ticket', async (req, res) => {
  try {
    const { ticket } = req.params;
    const entry = await journalManager.getEntryByTicket(ticket);
    res.json({ success: true, data: entry });
  } catch (error) {
    apiLogger.error(`Failed to get journal entry: ${error}`);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.post('/journal', async (req, res) => {
  try {
    const entry = await journalManager.createEntry(req.body);
    res.json({ success: true, data: entry });
  } catch (error) {
    apiLogger.error(`Failed to create journal entry: ${error}`);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.put('/journal/:ticket', async (req, res) => {
  try {
    const { ticket } = req.params;
    const entry = await journalManager.updateEntry(ticket, req.body);
    res.json({ success: true, data: entry });
  } catch (error) {
    apiLogger.error(`Failed to update journal entry: ${error}`);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.post('/journal/:ticket/note', async (req, res) => {
  try {
    const { ticket } = req.params;
    const { note } = req.body;
    const entry = await journalManager.addNote(ticket, note);
    res.json({ success: true, data: entry });
  } catch (error) {
    apiLogger.error(`Failed to add note to journal: ${error}`);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.get('/journal-stats', async (req, res) => {
  try {
    const { symbol, startDate, endDate } = req.query;
    const stats = await journalManager.getStats({
      symbol: symbol as string,
      startDate: startDate ? new Date(startDate as string) : undefined,
      endDate: endDate ? new Date(endDate as string) : undefined,
    });
    res.json({ success: true, data: stats });
  } catch (error) {
    apiLogger.error(`Failed to get journal stats: ${error}`);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.delete('/journal/:ticket', async (req, res) => {
  try {
    const { ticket } = req.params;
    const deleted = await journalManager.deleteEntry(ticket);
    res.json({ success: true, data: deleted });
  } catch (error) {
    apiLogger.error(`Failed to delete journal entry: ${error}`);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// --- AI Model Management & Dashboard (cloud + mobile) ---
// All mutating AI routes require the mobile JWT so train/promote work from the app
// against Render (or any hosted backend), not only localhost.
router.get('/ai/dashboard', requireAuth, async (_req, res) => {
  try {
    const data = await modelManager.getDashboard();
    res.json({ success: true, data });
  } catch (error) {
    apiLogger.error(`AI dashboard failed: ${error}`);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.get('/ai/training/status', requireAuth, (_req, res) => {
  res.json({ success: true, data: modelManager.getTrainingStatus() });
});

router.get('/ai/models', requireAuth, (_req, res) => {
  try {
    const reg = modelManager.getDashboard();
    reg.then((data) => res.json({ success: true, data: data.models, productionVersion: data.productionVersion }))
      .catch((error) => res.status(500).json({ success: false, error: (error as Error).message }));
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.post('/ai/train', requireAuth, userActionLimiter, async (req, res) => {
  try {
    const { dataPath, version, epochs } = req.body || {};
    const status = modelManager.getTrainingStatus();
    if (status.status === 'RUNNING') {
      return res.status(409).json({
        success: false,
        error: 'Training already running',
        data: status,
        auto_promoted: false,
      });
    }

    // Async job — return 202 immediately so Render/mobile do not hit gateway timeouts.
    const requestedEpochs = Number(epochs ?? process.env.CL_TRAIN_EPOCHS ?? process.env.TRAIN_EPOCHS ?? 20);
    const safeEpochs = Number.isFinite(requestedEpochs) ? Math.min(Math.max(requestedEpochs, 5), 30) : 20;
    const kickoff = modelManager.enqueueTraining({ dataPath, version, epochs: safeEpochs });
    if (!kickoff.accepted) {
      return res.status(409).json({
        success: false,
        error: kickoff.error || 'Unable to start training',
        data: modelManager.getTrainingStatus(),
        auto_promoted: false,
      });
    }

    apiLogger.info(`Cloud training accepted (${kickoff.dataSource})`);
    res.status(202).json({
      success: true,
      accepted: true,
      auto_promoted: false,
      data: modelManager.getTrainingStatus(),
      dataSource: kickoff.dataSource,
      note: 'Training started on the server. Poll GET /api/ai/training/status. Production is never auto-replaced — promote from the app when ready.',
    });
  } catch (error) {
    apiLogger.error(`AI train failed: ${error}`);
    res.status(500).json({ success: false, error: (error as Error).message, auto_promoted: false });
  }
});

router.post('/ai/promote', requireAuth, userActionLimiter, async (req, res) => {
  try {
    const { version } = req.body || {};
    if (!version) {
      return res.status(400).json({ success: false, error: 'version required' });
    }
    const result = await modelManager.promoteCandidate(version);
    res.json(result);
  } catch (error) {
    apiLogger.error(`AI promote failed: ${error}`);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.post('/ai/predict', requireAuth, async (req, res) => {
  try {
    const { features, symbol } = req.body || {};
    if (!Array.isArray(features)) {
      return res.status(400).json({ success: false, error: 'features array required' });
    }
    const prediction = await modelManager.predictWithProduction(features, symbol);
    res.json({ success: true, data: prediction, readOnlyProduction: true });
  } catch (error) {
    apiLogger.error(`AI predict failed: ${error}`);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// Production model is view-only — reject direct mutation attempts
router.put('/ai/production', requireAuth, (_req, res) => {
  res.status(403).json({
    success: false,
    error: 'Production model cannot be modified directly. Train a candidate and promote explicitly via POST /ai/promote.',
  });
});

router.patch('/ai/production', requireAuth, (_req, res) => {
  res.status(403).json({
    success: false,
    error: 'Production model is read-only. Use POST /ai/promote with a candidate version.',
  });
});

router.delete('/ai/production', requireAuth, (_req, res) => {
  res.status(403).json({
    success: false,
    error: 'Production model cannot be deleted via API.',
  });
});

// --- Monitoring ---
router.get('/monitoring', (_req, res) => {
  res.json({ success: true, data: monitoring.getSnapshot() });
});

router.get('/monitoring/alerts', (_req, res) => {
  const snap = monitoring.getSnapshot();
  res.json({ success: true, data: snap.alerts });
});

router.post('/monitoring/alerts/:id/ack', (req, res) => {
  const ok = monitoring.acknowledgeAlert(req.params.id);
  if (!ok) return res.status(404).json({ success: false, error: 'Alert not found' });
  res.json({ success: true });
});

router.get('/audit', (req, res) => {
  const limit = Number(req.query.limit) || 100;
  const category = req.query.category as any;
  res.json({ success: true, data: readAuditLog(limit, category) });
});

// --- Backtesting ---
router.post('/backtest', async (req, res) => {
  try {
    const { dataPath, modelVersion } = req.body || {};
    const result = await backtestEngine.run({ dataPath, modelVersion });
    res.json(result);
  } catch (error) {
    apiLogger.error(`Backtest failed: ${error}`);
    monitoring.trackFailure(`Backtest failed: ${error}`, 'ERROR');
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.get('/backtest/reports', (_req, res) => {
  res.json({ success: true, data: backtestEngine.listReports() });
});

router.get('/backtest/reports/:name', (req, res) => {
  try {
    res.json({ success: true, data: backtestEngine.readReport(req.params.name) });
  } catch (error) {
    res.status(404).json({ success: false, error: (error as Error).message });
  }
});

// --- Continuous Learning ---
router.get('/learning/status', requireAuth, (_req, res) => {
  res.json({ success: true, data: continuousLearning.getStatus() });
});

router.get('/learning/live', requireAuth, (_req, res) => {
  res.json({ success: true, data: liveTradeObserver.getStatus() });
});

router.post('/learning/train', requireAuth, userActionLimiter, async (_req, res) => {
  try {
    const kickoff = modelManager.enqueueTraining({ epochs: Number(process.env.CL_TRAIN_EPOCHS) || 60 });
    if (!kickoff.accepted) {
      return res.status(409).json({ success: false, error: kickoff.error, data: modelManager.getTrainingStatus(), auto_promoted: false });
    }
    res.status(202).json({
      success: true,
      accepted: true,
      data: modelManager.getTrainingStatus(),
      dataSource: kickoff.dataSource,
      auto_promoted: false,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.post('/learning/trade-completed', async (req, res) => {
  try {
    const analysis = await continuousLearning.onTradeCompleted(req.body);
    res.json({ success: true, data: analysis });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// --- Trading Simulation Engine ---
router.use('/simulation', simulationRouter);

// Export router and helper to attach to app
export const apiRouter = router;

export const attachAPI = (app: express.Application) => {
  app.use('/', apiRouter);
  app.use('/api', apiRouter);
  apiLogger.info('API layer attached (cloud AI train/promote, monitoring, backtest, continuous learning)');
};
