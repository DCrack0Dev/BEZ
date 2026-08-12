import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';

import { logger } from './logging';
import { TradingEngine } from './trading-engine';
import { attachAPI } from './api';
import { prisma, getCandles } from './database';
import { monitoring } from './monitoring';
import { continuousLearning } from './continuous-learning';
import {
  requireAuth,
  requireEaKey,
  signAccessToken,
  signRefreshToken,
  verifyToken,
  verifyEaApiKey,
  RefreshTokenPayload,
} from './middleware/auth';
import { eaValidateLimiter, userActionLimiter, eaPollingLimiter } from './middleware/rateLimiter';
import { validateBody, eaUpdateSchema, orderSchema, botConfigSchema, eaValidateSchema, eaExecutionReportSchema } from './middleware/validation';
import { replayGuard } from './middleware/replayGuard';
import { corsOriginCheck } from './middleware/corsConfig';
import { restoreFromDbIfCold, snapshotAllToDb, persistTrainingArtifacts } from './storage/cloudPersistence';

dotenv.config();

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 5000;

// EA heartbeats can include multi-TF candle arrays — parse JSON on the app itself
// (not only on the /api router) so /api/ea/* routes always see req.body.
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Initialize Socket.IO with an explicit CORS allowlist (see middleware/corsConfig.ts)
const io = new Server(server, { cors: { origin: corsOriginCheck, credentials: true } });
const tradingEngine = new TradingEngine(io);

// Gate Socket.IO connections behind a valid access JWT, passed via handshake auth
// or query param. This only guards the connection itself — what gets emitted after
// a successful connection is unchanged and owned by another agent.
io.use((socket, next) => {
  const token = (socket.handshake.auth && (socket.handshake.auth as any).token) || (socket.handshake.query as any)?.token;
  if (!token || typeof token !== 'string') {
    return next(new Error('unauthorized'));
  }
  try {
    const decoded = verifyToken<{ type: string }>(token);
    if (decoded.type !== 'access') {
      return next(new Error('unauthorized'));
    }
    (socket as any).user = decoded;
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});

// Global monitoring middleware (API latency / errors)
app.use(monitoring.middleware());

// Attach API
attachAPI(app);

// API Endpoints
app.post('/api/ea/validate', eaValidateLimiter, validateBody(eaValidateSchema), (req, res) => {
  const { apiKey } = req.body;
  logger.info('Auth request received');
  if (!verifyEaApiKey(apiKey)) {
    return res.status(401).json({ valid: false });
  }
  const subject = 'ea-license'; // no per-user identity available at this trust boundary
  const token = signAccessToken(subject, { plan: 'Lifetime Pro', maxTrades: 15, maxOpenTrades: 15 });
  const refreshToken = signRefreshToken(subject);
  return res.json({
    valid: true,
    token,
    refreshToken,
    expiry: '2027-12-31',
    plan: 'Lifetime Pro',
    maxTrades: 15,
    maxOpenTrades: 15,
  });
});

// Exchanges a refresh token for a new short-lived access token.
app.post('/api/auth/refresh', (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken || typeof refreshToken !== 'string') {
    return res.status(400).json({ success: false, error: 'refreshToken is required' });
  }
  try {
    const decoded = verifyToken<RefreshTokenPayload>(refreshToken);
    if (decoded.type !== 'refresh') {
      return res.status(401).json({ success: false, error: 'Invalid token type' });
    }
    const token = signAccessToken(decoded.sub, { plan: 'Lifetime Pro', maxTrades: 15, maxOpenTrades: 15 });
    res.json({ success: true, token });
  } catch {
    res.status(401).json({ success: false, error: 'Invalid or expired refresh token' });
  }
});

app.post('/api/ea/update', requireEaKey, eaPollingLimiter, validateBody(eaUpdateSchema), replayGuard, async (req, res) => {
  const start = Date.now();
  try {
    const data = req.body;
    await tradingEngine.processMT5Update(data);
    monitoring.trackBrokerResponse(true, Date.now() - start, 'EA_UPDATE');
    res.json({ success: true, commands: [] });
  } catch (error) {
    monitoring.trackBrokerResponse(false, Date.now() - start, 'EA_UPDATE_FAIL');
    monitoring.trackFailure(`EA update failed: ${error}`, 'BROKER');
    logger.error('Error in /api/ea/update', error);
    res.status(500).json({ success: false, error: 'Failed to process update' });
  }
});

app.get('/api/ea/commands', requireEaKey, eaPollingLimiter, (req, res) => {
  const cmds = tradingEngine.clearPendingCommands();
  if (cmds.length > 0) logger.info('Sent commands to EA', cmds.length);
  res.json(cmds);
});

// Broker-side execution detail report — second copy of truth next to journal.
// The EA's ReportExecution() in FxScalpKing_HTTP.mqh calls this after every
// order open/close/modify, requote, retry, slippage event, or broker error.
app.post('/api/ea/execution-report', requireEaKey, eaPollingLimiter, validateBody(eaExecutionReportSchema), replayGuard, async (req, res) => {
  const start = Date.now();
  try {
    const data = req.body;
    const ticket = String(data.ticket);
    const eventType = String(data.eventType);

    // 1. Persist raw execution report via Prisma (audit trail)
    await prisma.auditLog.create({
      data: {
        category: 'EXECUTION',
        action: eventType,
        version: data.symbol || undefined,
        actor: 'mt5-ea',
        details: {
          ticket,
          ...data,
          serverReceivedAt: new Date().toISOString(),
        },
      },
    });

    // 2. Update journal if this ticket already has an AdvancedTradeJournal row
    const patches: Record<string, any> = {};
    if (data.slippagePips !== undefined) patches.slippage = Number(data.slippagePips);
    if (data.spreadAtExecution !== undefined) patches.spreadAtEntry = Number(data.spreadAtExecution);
    if (data.executionPrice !== undefined) patches.executionPrice = Number(data.executionPrice);
    if (data.latencyMs !== undefined) {
      patches.marketSnapshot = { ...(patches.marketSnapshot || {}), eaLatencyMs: Number(data.latencyMs) };
    }
    if (Object.keys(patches).length > 0) {
      await prisma.advancedTradeJournal.updateMany({
        where: { ticket },
        data: patches,
      }).catch(() => {}); // journal row may not exist yet — non-fatal
    }

    // 3. Notify realtime dashboards via Socket.IO
    io.emit('EA_EXECUTION_REPORT', { ticket, eventType, data, receivedAt: new Date().toISOString() });

    monitoring.trackBrokerResponse(true, Date.now() - start, `EA_EXEC_${eventType}`);
    res.json({ success: true, acknowledged: true, ticket });
  } catch (error) {
    monitoring.trackBrokerResponse(false, Date.now() - start, 'EA_EXEC_FAIL');
    monitoring.trackFailure(`EA execution-report failed: ${error}`, 'BROKER');
    logger.error('Error in /api/ea/execution-report', error);
    res.status(500).json({ success: false, error: 'Failed to persist execution report' });
  }
});

app.get('/api/account', requireAuth, (req, res) => res.json(tradingEngine.getAccountState()));
app.get('/api/orders/closed', requireAuth, (req, res) => res.json(tradingEngine.getClosedTrades()));
app.post('/api/order', requireAuth, userActionLimiter, validateBody(orderSchema), replayGuard, (req, res) => {
  if (req.body.action === 'RESUME' || req.body.action === 'PAUSE') {
    const state = tradingEngine.getAccountState();
    tradingEngine.processMT5Update({ ...state, autoTradingEnabled: req.body.action === 'RESUME' } as any);
    return res.json({ success: true });
  }

  // Manual BUY/SELL must carry risk-sized lots + SL/TP — never blind-forward.
  const action = String(req.body.action || '').toUpperCase();
  if (action === 'BUY' || action === 'SELL') {
    const state = tradingEngine.getAccountState();
    const lots = Number(req.body.lots);
    const sl = Number(req.body.sl);
    const tp = Number(req.body.tp);
    if (!Number.isFinite(lots) || lots <= 0) {
      return res.status(400).json({ success: false, error: 'lots required and must be > 0' });
    }
    if (!Number.isFinite(sl) || sl <= 0 || !Number.isFinite(tp) || tp <= 0) {
      return res.status(400).json({ success: false, error: 'sl and tp required for manual BUY/SELL' });
    }
    if (lots < (state.minLot || 0.01) || lots > (state.maxLot || 100)) {
      return res.status(400).json({ success: false, error: `lots outside broker min/max (${state.minLot}-${state.maxLot})` });
    }
    if ((state.positions?.length || 0) >= 5) {
      return res.status(400).json({ success: false, error: 'max open positions reached' });
    }
    tradingEngine.addCommand({
      action,
      symbol: req.body.symbol || state.symbol,
      lots,
      sl,
      tp,
    });
    return res.json({ success: true });
  }

  tradingEngine.addCommand(req.body);
  res.json({ success: true });
});
app.post('/api/bot/config', requireAuth, userActionLimiter, validateBody(botConfigSchema), replayGuard, (req, res) => {
  tradingEngine.applyBotConfig({
    autoTradingEnabled: req.body.autoTradingEnabled,
    timezoneTradingEnabled: req.body.timezoneTradingEnabled,
    maxSpreadPoints: req.body.maxSpreadPoints,
  });
  tradingEngine.addCommand({ action: 'CONFIG_SYNC', ...req.body });
  res.json({
    success: true,
    autoTradingEnabled: tradingEngine.getAccountState().autoTradingEnabled,
    timezoneTradingEnabled: tradingEngine.getAccountState().timezoneTradingEnabled,
    maxSpreadPoints: tradingEngine.getAccountState().maxSpreadPoints,
  });
});
app.get('/api/subscription', requireAuth, (req, res) => res.json({ active: true, plan: 'Lifetime Pro', expiry: '2027-12-31' }));
app.get('/api/dna', requireAuth, (req, res) => res.json(tradingEngine.getDna()));
app.get('/api/lessons', requireAuth, (req, res) => res.json(tradingEngine.getLessons()));
app.get('/api/models', requireAuth, async (req, res) => {
  try {
    const { modelManager } = await import('./model-management');
    const dash = await modelManager.getDashboard();
    res.json(dash.models);
  } catch {
    res.json([]);
  }
});
app.get('/api/features', requireAuth, (req, res) => res.json(tradingEngine.getAccountState().lastFeatures || {}));
app.get('/api/ai/dashboard', requireAuth, async (req, res) => {
  try {
    const { modelManager } = await import('./model-management');
    res.json({ success: true, data: await modelManager.getDashboard() });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// Explicit AI train/backtest routes (also on api router) so cloud deploys always expose them
app.get('/api/ai/training/status', requireAuth, async (_req, res) => {
  try {
    const { modelManager } = await import('./model-management');
    res.json({ success: true, data: modelManager.getTrainingStatus() });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

app.post('/api/ai/train', requireAuth, userActionLimiter, async (req, res) => {
  try {
    const { modelManager } = await import('./model-management');
    const kickoff = modelManager.enqueueTraining({
      version: req.body?.version,
      epochs: req.body?.epochs ?? 40,
      dataPath: req.body?.dataPath,
    });
    if (!kickoff.accepted) {
      return res.status(409).json({
        success: false,
        accepted: false,
        error: kickoff.error || 'Unable to start training',
        status: kickoff.status,
        data: modelManager.getTrainingStatus(),
      });
    }
    return res.status(202).json({
      success: true,
      accepted: true,
      auto_promoted: false,
      status: kickoff.status,
      data: modelManager.getTrainingStatus(),
      dataSource: kickoff.dataSource,
      note: 'Training started. Poll GET /api/ai/training/status.',
    });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

app.post('/api/ai/promote', requireAuth, userActionLimiter, async (req, res) => {
  try {
    const { modelManager } = await import('./model-management');
    const version = String(req.body?.version || '');
    if (!version) return res.status(400).json({ success: false, error: 'version required' });
    const result = await modelManager.promoteCandidate(version);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

app.post('/api/backtest', requireAuth, userActionLimiter, async (req, res) => {
  try {
    const { backtestEngine } = await import('./backtesting');
    const result = await backtestEngine.run({
      dataPath: req.body?.dataPath,
      modelVersion: req.body?.modelVersion,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

app.get('/api/backtest/reports', requireAuth, async (_req, res) => {
  try {
    const { backtestEngine } = await import('./backtesting');
    res.json({ success: true, data: backtestEngine.listReports() });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// --- Cloud Storage Persistence (Ephemeral FS Safety) ---
// Dual-writes saved_models, saved_scalers, data/learning to Postgres BYTEA blobs,
// restores from DB on cold-boot. Render Persistent Disk optional.
app.post('/api/storage/sync', requireAuth, userActionLimiter, async (_req, res) => {
  try {
    const result = await snapshotAllToDb();
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

app.get('/api/storage/status', requireAuth, async (_req, res) => {
  try {
    const artifacts = await prisma.modelArtifact.groupBy({
      by: ['type'],
      _count: { _all: true },
      _sum: { sizeBytes: true },
    });
    res.json({ success: true, data: artifacts });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// New Historical API Endpoints
app.get('/api/candles', requireAuth, async (req, res) => {
  try {
    const { symbol, timeframe, limit } = req.query;
    const candles = await getCandles(
      (symbol as string) || 'XAUUSD',
      (timeframe as string) || 'M5',
      Number(limit) || 1000
    );
    res.json(candles);
  } catch (error) {
    logger.error('Failed to fetch candles', error);
    res.status(500).json({ success: false, error: 'Failed to fetch candles' });
  }
});

// Socket.IO
io.on('connection', (socket) => {
  logger.info('Client connected', socket.id);
  socket.emit('EA_HEARTBEAT', tradingEngine.getAccountState());
  socket.on('disconnect', () => logger.info('Client disconnected', socket.id));
});

// Start server
async function startServer() {
  // --- Cloud cold-start restore BEFORE engine init ---
  // Render/Railway/Fly wipe the container FS on deploy. If saved_models/registry.json
  // is missing on disk, pull everything from the ModelArtifact table (Postgres BYTEA blobs)
  // so training history, production model, scalers, and labeled dataset survive restarts.
  const restore = await restoreFromDbIfCold();
  if (restore.restored > 0) {
    logger.success(`[CloudPersistence] Restored ${restore.restored} artifacts from DB on cold boot`);
  }

  await tradingEngine.init();
  continuousLearning.start();
  server.listen(Number(PORT), '0.0.0.0', () => {
    logger.success('LiquiBot backend v4.0 LIVE on port', PORT);
    logger.info('Monitoring + continuous learning active');
    if (process.env.NODE_ENV === 'production') {
      logger.info('[CloudPersistence] Running in production — models/scalers/datasets dual-written to FS + DB');
      // Background snapshot of any pre-existing FS state on first boot (idempotent)
      setTimeout(() => snapshotAllToDb().catch(() => {}), 10000);
    }
  });
}

startServer();
