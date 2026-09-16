import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import http from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';

import { logger } from './logging';
import { TradingEngine } from './trading-engine';
import { attachAPI } from './api';
import { prisma, getCandles, listGateProposals, approveProposal, rejectProposal, checkDbHealth } from './database';
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
  eaApiKeyDiagnostic,
} from './middleware/auth';
import { eaValidateLimiter, userActionLimiter, eaPollingLimiter, eaCommandsLimiter } from './middleware/rateLimiter';
import { validateBody, eaUpdateSchema, orderSchema, botConfigSchema, eaValidateSchema, eaExecutionReportSchema } from './middleware/validation';
import { replayGuard } from './middleware/replayGuard';
import { corsOriginCheck } from './middleware/corsConfig';
import { eaTraceMiddleware } from './middleware/requestTrace';
import { restoreFromDbIfCold, snapshotAllToDb, persistTrainingArtifacts } from './storage/cloudPersistence';
import { gateConfig, GATE_DEFAULTS } from './gate-config/gateConfig';

dotenv.config();

// Rolling last-commands cache (dup of latest /update inline payload). Legacy EA
// builds (pre-inline-commands) still call GET /api/ea/commands separately
// AFTER /update. The /update route runs tradingEngine.clearPendingCommands()
// for new EAs — that would leave old EAs starved of commands forever if the
// backend queue flushed before compat poll ran (zero trades with old compiled
// .ex5 files). Cache returns the same command set once (backward compat), for
// up to ~120s of stale retries. New EAs ignore the /commands route entirely.
let lastCommandsCache: any[] = [];
let lastCommandsCachedAt = 0;
const COMMANDS_CACHE_TTL_MS = 120_000;

const app = express();
// Render always runs behind a Cloudflare LB + their own nginx reverse proxy.
// Without trustProxy:true, Express sees every request from the LB's 10.x IP
// (same for ALL customers on Render shared space → rate limiter buckets merged).
// With trustProxy: true, X-Forwarded-For = real client IP (EA home MT5 IP vs
// random internet scanners that probe liquibot-back.onrender.com → separate
// rate limit buckets = NO more anonymous scanners burning the EA's bucket.
app.set('trust proxy', true);
// Helmet early: basic HTTP security headers. Uses permissive crossOriginResourcePolicy
// and crossOriginEmbedderPolicy so cross-origin RN apps render embedded fonts/images
// (Expo Go / WebView devtools).
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
    frameguard: false, // required for embedded dashboards / embedded views
  })
);
// Global CORS BEFORE routes (socket.io has own CORS explicit in Server({ cors: }) for socket but HTTP routes here.
// app.use(cors(...)) covers ALL methods including OPTIONS preflights, so we don't need a separate
// app.options('*') call — Express 5 / path-to-regexp v7 rejects bare '*' as a route (PathError).
app.use(cors({ origin: corsOriginCheck, credentials: true }));

const server = http.createServer(app);
const PORT = Number(process.env.PORT) || 5000;
const RENDER_PORT_WATCHDOG_MS = 8_000;

// EA heartbeats can include multi-TF candle arrays — parse JSON on the app itself
// (not only on the /api router) so /api/ea/* routes always see req.body.
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Initialize Socket.IO with an explicit CORS allowlist (see middleware/corsConfig.ts)
// Enable per-message deflate + low threshold for small tick heartbeats too.
const io = new Server(server, {
  cors: { origin: corsOriginCheck, credentials: true },
  perMessageDeflate: {
    zlibDeflateOptions: { level: 3, memLevel: 7 },
    zlibInflateOptions: { windowBits: 14 },
    threshold: 128,
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
  },
  pingInterval: 18000,
  pingTimeout: 9000,
});
const tradingEngine = new TradingEngine(io);

// Throttle fast-path socket broadcasts: max 4 quick updates per second per server.
// EA ticks can come every 100-200ms; anything faster than 250ms is undetectable to
// humans and would just double-process store updates on the client.
let lastQuickEmitAt = 0;
const QUICK_EMIT_MIN_MS = 250;

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

// Root + health checks BEFORE attachAPI — they exist once.
//
// Render deploy health: by default the deploy probe GETs `/` repeatedly every
// 2–5s during the "Waiting for deploy" phase, then stops when it gets 200. If
// every `/` probe runs checkDbHealth (SELECT 1 + 3 COUNT(*) queries on
// Postgres free-tier), that's N * 4 concurrent Postgres calls while the pod
// is still bootstrapping — plus migrate deploy running its own connections.
// Together those easily exceed Render Postgres Free's TOTAL 5 connection cap:
//   migrate deploy: 1
//   deploy probe × 5 concurrent: 5 × 4 Prisma connections = 20
//   Prisma pool warmup: 2
//   Total: 23, Postgres allows: 5 → all sockets hang, Render says "Timed Out".
//
// Fix:
//   /            → fast HTTP 200 with NO DB work. Render deploy passes instantly.
//   /health-fast → same fast responder (explicit for dashboard Health Check Path).
//   /health      → real SELECT 1 + counts (load balancer watchdog, runs AFTER deploy).
//   /health?full=1 OR /?full=1 → real DB checks (optional for debugging via browser).
// attachAPI() mounts handlers only under /api to avoid duplicates.
const FAST_HEALTH = {
  success: true,
  service: 'LiquiBot Backend',
  status: 'UP' as const,
  fast: true,
  version: '4.0.0',
  time: new Date().toISOString(),
};
async function healthPayload({ full }: { full: boolean }) {
  if (!full) {
    return { http: 200, payload: { ...FAST_HEALTH, time: new Date().toISOString() } };
  }
  let db: any = null;
  let statusLabel: 'UP' | 'DEGRADED' | 'DOWN' = 'UP';
  let http = 200;
  try {
    const race = (await Promise.race([
      checkDbHealth(),
      new Promise<any>((resolve) =>
        setTimeout(() => resolve({ ok: false, latencyMs: 3000, error: 'timeout' }), 3000)
      ),
    ])) as any;
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
  return { http, payload: {
    success: statusLabel !== 'DOWN',
    service: 'LiquiBot Backend',
    status: statusLabel,
    version: '4.0.0',
    time: new Date().toISOString(),
    postgres: db,
  }};
}

// Render's deploy probe + dashboard Health Check Path: always fast, no DB.
app.get('/health-fast', (_req, res) => {
  res.status(200).json({ ...FAST_HEALTH, time: new Date().toISOString() });
});
// Render deploy default probe path is `/` — keep that FAST by default unless
// caller explicitly asks for full checks via ?full=1 (browser debug).
app.get('/', async (req, res) => {
  const full = String(req.query.full || '') === '1';
  const { http, payload } = await healthPayload({ full });
  res.status(http).json(payload);
});
// /health: real full watchdog SELECT 1 by default (Render LB will call this
// occasionally post-deploy). Fast 200 if you set Health Check Path on dashboard.
app.get('/health', async (req, res) => {
  const skip = String(req.query.fast || '') === '1';
  const { http, payload } = await healthPayload({ full: !skip });
  res.status(http).json(payload);
});
app.head('/', (_req, res) => res.status(200).end());
app.head('/health', (_req, res) => res.status(200).end());
app.head('/health-fast', (_req, res) => res.status(200).end());

// Stop the /test 404 flood from Render deploy probes (seen in logs: 7+ GET
// /test 404 spam per deploy creating ALERT WARNING entries that drown out real
// alerts). Respond 204 No Content to any /test probe noise.
app.all('/test', (_req, res) => res.status(204).end());

// Attach API — see attachAPI for router mount details. Now mounts ONLY at /api
// (never also at /) to avoid duplicate handlers, double auth, double CORS.
attachAPI(app);

// API Endpoints
app.post('/api/ea/validate', eaTraceMiddleware, eaValidateLimiter, validateBody(eaValidateSchema), (req, res) => {
  const { apiKey } = req.body;
  logger.info('Auth request received');
  if (!verifyEaApiKey(apiKey)) {
    (res.locals as any).authVerdict = (res.locals as any).authVerdict || 'FAIL_INVALID';
    return res.status(401).json({ valid: false });
  }
  (res.locals as any).authVerdict = 'PASS';
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

app.post('/api/ea/update',
  // TRACE FIRST — log the request even if auth fails (to spot scanner probes).
  eaTraceMiddleware,
  // AUTH FIRST — anonymous probes get 401 BEFORE they touch the rate limiter.
  // Old order (rateLimit THEN requireEaKey) = anonymous scanners shared the
  // EA's IP/api-key bucket (they all hit /api/ea/update first from the same
  // Render shared LB trustProxy-bucket), which is exactly what caused the
  // random "429 allowlist liquibot-back.onrender.com ApiKey must match" bursts
  // in the ScalpKing EA v3 Expert log.
  requireEaKey,
  eaPollingLimiter,
  validateBody(eaUpdateSchema),
  replayGuard,
  async (req, res) => {
  const start = Date.now();
  const data = req.body;
  // INSTANT RACE-FREE SYNC: broadcast hot fields DIRECTLY from EA payload BEFORE
  // running processMT5Update (which can take 10-50ms running signal validators).
  // This guarantees the mobile app sees the EA's latest equity/price/tick within
  // one single network hop (EA → backend → app Socket) with no processing delay.
  const now = Date.now();
  if (now - lastQuickEmitAt >= QUICK_EMIT_MIN_MS) {
    lastQuickEmitAt = now;
    try {
      const quickPrice = Number(data.price ?? data.lastPrice ?? data.bid ?? 0);
      const quickSpread = Number(data.spread ?? 0);
      const quickBalance = Number(data.balance ?? data.account_balance ?? 0);
      const quickEquity = Number(data.equity ?? data.account_equity ?? 0);
      const quickPositions = Array.isArray(data.positions)
        ? data.positions.map((p: any) => ({
            ticket: String(p.ticket ?? p.id),
            symbol: p.symbol,
            type: p.type,
            volume: Number(p.volume ?? p.lots ?? 0),
            lots: Number(p.volume ?? p.lots ?? 0),
            openPrice: Number(p.openPrice ?? p.price ?? 0),
            price: Number(p.openPrice ?? p.price ?? 0),
            profit: Number(p.profit ?? p.pnl ?? 0),
            pnl: Number(p.profit ?? p.pnl ?? 0),
            time: p.time ?? null,
          }))
        : undefined;
      io.emit('EA_HEARTBEAT_QUICK', {
        positions: quickPositions,
        price: quickPrice || undefined,
        spread: quickSpread || undefined,
        balance: quickBalance || undefined,
        equity: quickEquity || undefined,
        currency: data.currency || 'USD',
        lastUpdate: Date.now(),
        ea_connected: true,
        // NOTE: DO NOT accept EA payload autoTrading/aiTrading/trailing flags here.
        // Mobile app user toggles are APP-USER-OWNED; EA heartbeats happen every
        // 60s with stale auto/ai/trailing=false from broker/MT5 state which would
        // flip the switches OFF against the user's intent. Use the server-side
        // persisted Postgres BotSetting values instead (tradingEngine owns state).
        autoTradingEnabled: (tradingEngine.getAccountState() as any).autoTradingEnabled,
        aiTradingEnabled: (tradingEngine.getAccountState() as any).aiTradingEnabled,
        trailingStopEnabled: (tradingEngine.getAccountState() as any).trailingStopEnabled,
        serverTs: Date.now(),
        fastPath: true,
      });
    } catch (_emitErr) { /* no-op: engine emits full copy below */ }
  }

  try {
    await tradingEngine.processMT5Update(data);
    monitoring.trackBrokerResponse(true, Date.now() - start, 'EA_UPDATE');
    // Return commands[] inline so the EA does NOT need to run a separate tight
    // poll loop on /api/ea/commands — that was the single largest contributor
    // to Cloudflare 429 challenge pages (half of all EA HTTP requests were
    // separate /commands polls). Backwards-compat: /commands endpoint still
    // works for older EAs.
    const commands = tradingEngine.clearPendingCommands();
    // Populate backward-compat cache for old EAs (pre-inline commands).
    // New EAs parse the inline commands[] in this JSON response directly; old
    // ones run a separate GET /api/ea/commands 1ms later — without this cache
    // the queue is already empty and OLD .ex5 files get zero trades forever.
    if (commands.length > 0) {
      lastCommandsCache = commands;
      lastCommandsCachedAt = Date.now();
      logger.info('Sent commands (inline update) to EA', commands.length);
    }
    res.json({ success: true, commands });
  } catch (error) {
    monitoring.trackBrokerResponse(false, Date.now() - start, 'EA_UPDATE_FAIL');
    monitoring.trackFailure(`EA update failed: ${error}`, 'BROKER');
    logger.error('Error in /api/ea/update', error);
    res.status(500).json({ success: false, error: 'Failed to process update', commands: [] });
  }
});

app.get('/api/ea/commands',
  // Same reorder: trace first, then auth before rate limit. Compat poll route for older EA
  // builds that haven't read commands[] inline from /update response body.
  eaTraceMiddleware,
  requireEaKey,
  eaCommandsLimiter,
  (req, res) => {
  // Fresh queue = new EAs (inline) cleared this cycle. Fall back to the
  // rolling 120s TTL cache populated by the latest /update inline payload
  // so old .ex5 builds still receive the command set instead of [].
  let cmds = tradingEngine.clearPendingCommands();
  if (cmds.length === 0 && lastCommandsCache.length > 0) {
    const age = Date.now() - lastCommandsCachedAt;
    if (age < COMMANDS_CACHE_TTL_MS) {
      cmds = lastCommandsCache;
      logger.info('Sent cached commands to legacy EA (/commands compat)', { count: cmds.length, ageMs: age });
    }
  } else if (cmds.length > 0) {
    // Legacy EA hit /commands BEFORE /update (order jitter). Populate cache
    // here too; inline-clear on the subsequent /update won't double-deliver
    // because clearPendingCommands returns [] after this call.
    lastCommandsCache = cmds;
    lastCommandsCachedAt = Date.now();
    logger.info('Sent commands to EA (/commands compat)', cmds.length);
  }
  res.json(cmds);
});

// Broker-side execution detail report — second copy of truth next to journal.
// The EA's ReportExecution() in FxScalpKing_HTTP.mqh calls this after every
// order open/close/modify, requote, retry, slippage event, or broker error.
app.post('/api/ea/execution-report',
  // Auth first — same rationale as /update and /commands above.
  eaTraceMiddleware,
  requireEaKey,
  eaPollingLimiter,
  validateBody(eaExecutionReportSchema),
  replayGuard,
  async (req, res) => {
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

// Safe EA API key diagnostic — returns length + SHA-256 fingerprint prefix only,
// NEVER the secret. Requires a valid key so anonymous probes never see the fingerprint.
app.get('/api/ea/diag', eaTraceMiddleware, requireEaKey, (_req, res) => {
  const diag = eaApiKeyDiagnostic();
  res.json({
    success: true,
    ...diag,
    matchesSupplied: true, // route passed requireEaKey → caller's header matched
    serverTs: new Date().toISOString(),
    version: '4.0.0',
  });
});

app.get('/api/account', requireAuth, (req, res) => res.json(tradingEngine.getAccountState()));
app.get('/api/orders/closed', requireAuth, async (req, res) => {
  try {
    const raw = String(req.query.filter || 'all').toLowerCase();
    const range: 'today' | 'week' | 'month' | 'all' =
      raw === 'today' || raw === 'week' || raw === 'month' ? raw : 'all';
    const merged = await tradingEngine.getClosedTradesWithJournal(range);
    res.json(merged);
  } catch (e) {
    const memory = tradingEngine.getClosedTrades();
    const raw = String(req.query.filter || 'all').toLowerCase();
    if (raw === 'today' || raw === 'week' || raw === 'month') {
      const now = Date.now();
      const ms =
        raw === 'today' ? 24 * 3600 * 1000
        : raw === 'week' ? 7 * 24 * 3600 * 1000
        : 31 * 24 * 3600 * 1000;
      const since = now - ms;
      res.json(memory.filter((c: any) => Number(c.closeTime || since) >= since));
      return;
    }
    res.json(memory);
  }
});
app.post('/api/order', requireAuth, userActionLimiter, validateBody(orderSchema), replayGuard, (req, res) => {
  if (req.body.action === 'RESUME' || req.body.action === 'PAUSE') {
    const nextAuto = req.body.action === 'RESUME';
    const state = tradingEngine.getAccountState();
    tradingEngine.processMT5Update({ ...state, autoTradingEnabled: nextAuto } as any);
    // Persist the new autoTradingEnabled flag to Postgres BotSetting (survives
    // Render restart). The app can hit RESUME/PAUSE via dashboard as well as
    // via the autoTradingEnabled toggle UI; both paths must write DB.
    (tradingEngine as any).applyBotConfig({ autoTradingEnabled: nextAuto });
    return res.json({ success: true, autoTradingEnabled: nextAuto });
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
// GET /api/bot/config: lets the mobile app hydrate switches BEFORE socket.io
// handshake, so the UI renders correct toggle state even on cold app boot
// (socket.io has optional auth handshake that can take 1-3s, the user sees
// switches flash to defaults then flip back otherwise). Returns same shape as
// BOT_CONFIG socket broadcast.
app.get('/api/bot/config', requireAuth, (_req, res) => {
  const st = tradingEngine.getAccountState() as any;
  res.json({
    success: true,
    autoTradingEnabled: Boolean(st.autoTradingEnabled),
    aiTradingEnabled: Boolean(st.aiTradingEnabled),
    trailingStopEnabled: Boolean(st.trailingStopEnabled),
    timezoneTradingEnabled: Boolean(st.timezoneTradingEnabled),
    maxSpreadPoints: Number(st.maxSpreadPoints),
    source: 'db_memory',
  });
});
app.post('/api/bot/config', requireAuth, userActionLimiter, validateBody(botConfigSchema), replayGuard, (req, res) => {
  tradingEngine.applyBotConfig({
    autoTradingEnabled: req.body.autoTradingEnabled,
    aiTradingEnabled: req.body.aiTradingEnabled,
    trailingStopEnabled: req.body.trailingStopEnabled,
    timezoneTradingEnabled: req.body.timezoneTradingEnabled,
    maxSpreadPoints: req.body.maxSpreadPoints,
  });
  tradingEngine.addCommand({ action: 'CONFIG_SYNC', ...req.body });
  const st = tradingEngine.getAccountState() as any;
  res.json({
    success: true,
    autoTradingEnabled: Boolean(st.autoTradingEnabled),
    aiTradingEnabled: Boolean(st.aiTradingEnabled),
    trailingStopEnabled: Boolean(st.trailingStopEnabled),
    timezoneTradingEnabled: Boolean(st.timezoneTradingEnabled),
    maxSpreadPoints: Number(st.maxSpreadPoints),
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

// Diagnostic endpoint: returns training/backtest diagnostics and a lightweight Python deps check.
app.get('/api/ai/diagnostics', requireAuth, async (_req, res) => {
  try {
    const { modelManager } = await import('./model-management');
    // modelManager.getDiagnostics never blocks (returns cached sync copy). If
    // the python check is stale, getDiagnostics fires a non-blocking refresh.
    const sync = modelManager.getDiagnostics();
    // Also await the current async python check so the very first poll still
    // gets a populated result, but never for more than 2s (fall back to sync).
    const withPython = await Promise.race([
      modelManager.getPythonCheckAsync().then((pythonCheck) => ({ ...sync, pythonCheck })),
      new Promise<typeof sync>((resolve) => setTimeout(() => resolve(sync), 2000)),
    ]);
    res.json({ success: true, data: withPython });
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

app.post('/api/ai/train/reset', requireAuth, userActionLimiter, async (req, res) => {
  try {
    const { modelManager } = await import('./model-management');
    const reason = (req.body?.reason && typeof req.body.reason === 'string')
      ? req.body.reason.slice(0, 300)
      : 'User requested reset via API';
    const r = modelManager.resetTraining(reason);
    return res.json({ success: true, ok: r.ok, data: modelManager.getTrainingStatus() });
  } catch (error) {
    res.status(500).json({ success: false, error: String(error) });
  }
});

// NOTE: /api/ai/promote is registered ONLY in attachAPI router (/api mount) to avoid
// duplicate handlers. Do NOT re-register it here — previous double-registration caused
// ERR_HTTP_HEADERS_SENT and risk of double-promotion on the same request.

// NOTE: /api/backtest* routes are handled INSIDE attachAPI → router.post('/backtest', …)
// (202 Accepted + /status poll), NOT here in main.ts. Previous blocking
// `await backtestEngine.run()` in main.ts caused event loop starvation and the
// classic "Backtest clicked → Train on Cloud button dies, everything Network Error" bug.

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

// ============================================================
//  HUMAN-IN-THE-LOOP AI: Proposed Gate Adjustments API
//  Every proposed ADD / REMOVE / MODIFY is ALWAYS
//  PENDING_APPROVAL until the user calls /approve below.
// ============================================================
app.get('/api/ai/gates', requireAuth, async (_req, res) => {
  try {
    res.json({
      success: true,
      data: gateConfig.allEntries(),
      _defaults: Object.fromEntries(
        Object.entries(GATE_DEFAULTS).map(([k, v]) => [k, { defaultValue: v.defaultValue, type: v.type, label: v.label, min: v.min, max: v.max }])
      ),
    });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e) });
  }
});

app.post('/api/ai/gates/:key', requireAuth, userActionLimiter, async (req, res) => {
  try {
    const key = String(req.params.key);
    const body: any = req.body || {};
    const desired = body.value;
    const comment = body.comment || undefined;
    if (desired === undefined || desired === null) {
      return res.status(400).json({ success: false, error: 'Missing required `value`' });
    }
    const ok = await gateConfig.setManualOverride(key, Number(desired), 'USER', comment);
    if (!ok) return res.status(404).json({ success: false, error: `Unknown gate key: ${key}` });
    res.json({ success: true, data: gateConfig.allEntries() });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e) });
  }
});

app.get('/api/ai/proposals', requireAuth, async (req, res) => {
  try {
    const status = req.query.status as string | undefined;
    const data = await listGateProposals({ status });
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e) });
  }
});

// --- USER EXPLICITLY APPROVES A PROPOSAL (the ONLY place where a proposal becomes effective!) ---
app.post('/api/ai/proposals/:id/approve', requireAuth, userActionLimiter, async (req, res) => {
  try {
    const id = String(req.params.id);
    const body: any = req.body || {};
    const reviewer = body.reviewedBy || 'USER';
    const comment = body.comment || undefined;
    const result = await approveProposal(id, reviewer, comment);
    if (!result) return res.status(404).json({ success: false, error: `Proposal not found or not applicable` });
    if (result.override) {
      // Push the newly applied override into the running GateConfig singleton
      // so the next signal immediately uses it (no restart needed).
      gateConfig._applyApprovedProposal(
        String((result.proposal as any).targetGateKey),
        Number((result.proposal as any).proposedValue),
        comment,
      );
    }
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e) });
  }
});

app.post('/api/ai/proposals/:id/reject', requireAuth, userActionLimiter, async (req, res) => {
  try {
    const id = String(req.params.id);
    const body: any = req.body || {};
    const reviewer = body.reviewedBy || 'USER';
    const comment = body.comment || undefined;
    const result = await rejectProposal(id, reviewer, comment);
    if (!result) return res.status(404).json({ success: false, error: `Proposal not found` });
    res.json({ success: true, data: result });
  } catch (e) {
    res.status(500).json({ success: false, error: String(e) });
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
  // /health-fast must be registered BEFORE server.listen() executes any
  // net.Server#listen path resolution. Render's orchestrator opens its
  // outbound TCP probe within ~200ms of PORT being bound; if the handler
  // isn't yet attached we can get a SYN→RST that the probe interprets as
  // "port not open", even though listen() completed synchronously.
  app.get('/health-fast', (_req, res) => {
    res.type('application/json');
    res.status(200).json({ status: 'UP', fast: true, ts: Date.now() });
  });
  app.get('/health', (_req, res) => {
    res.type('application/json');
    res.status(200).json({
      status: 'ok',
      service: 'liquibot-backend',
      timestamp: new Date().toISOString(),
      version: '4.0',
    });
  });

  logger.info('[Boot] Preparing to bind HTTP port', {
    port: PORT,
    isNumber: Number.isFinite(PORT),
    host: '0.0.0.0',
    renderServiceId: process.env.RENDER_SERVICE_ID ? 'SET' : 'UNSET',
    nodeEnv: process.env.NODE_ENV || 'dev',
  });

  // Render "Timed Out deploy" root cause: server.listen(Number, '0.0.0.0', cb)
  // only calls cb on SUCCESS. On EADDRINUSE / EACCES / kernel bind timeout the
  // callback never fires, so await hangs forever and the deploy watchdog kills
  // us at ~30s total (build+deploy+probe window). We also race against a hard
  // 8s watchdog so Render's ~10s deploy probe window is never exhausted.
  let listenErrored = false;
  const httpListenPromise = new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      listenErrored = true;
      logger.error('[Listen] server error event', {
        code: err.code, message: err.message, syscall: err.syscall, port: PORT,
      });
      reject(err);
    });
    try {
      server.listen(Number(PORT), '0.0.0.0', () => {
        resolve();
      });
    } catch (e) {
      listenErrored = true;
      logger.error('[Listen] server.listen() threw synchronously', { error: String(e), port: PORT });
      reject(e);
    }
  });

  const watchdogPromise = new Promise<never>((_, reject) => {
    const t = setTimeout(() => {
      clearTimeout(t);
      if (!listenErrored) {
        logger.error('[Listen] watchdog fired — listen did not complete within', RENDER_PORT_WATCHDOG_MS, 'ms. Killing process so Render retries a fresh cold-start.');
      }
      reject(new Error(`listen watchdog timed out after ${RENDER_PORT_WATCHDOG_MS}ms`));
    }, RENDER_PORT_WATCHDOG_MS);
  });

  await Promise.race([httpListenPromise, watchdogPromise]);
  logger.info('[Listen] HTTP + Socket.IO port bound, Render probes see 200 on /health-fast and /health', {
    port: PORT,
    address: (server.address() as any)?.address,
    family: (server.address() as any)?.family,
  });
  {
    const diag = eaApiKeyDiagnostic();
    logger.info('[EA_DIAG] Boot config', {
      eaKeyConfigured: diag.configured,
      eaKeyLength: diag.length,
      eaKeyFingerprint: diag.fingerprintSha256First8,
      eaPollingLimitPer10Min: 6000,
      eaCommandsLimitPer10Min: 6000,
      eaValidateLimitPerMin: 60,
      inlineCommands: true,
      commandsCacheTtlMs: COMMANDS_CACHE_TTL_MS,
    });
  }

  // --- Cloud cold-start restore + engine init AFTER port bind.
  // Render deploy already succeeded once we bound PORT; if Prisma free-tier
  // cold-start takes 25+s we do NOT want the deploy watchdog to retroactively
  // time out. Run this block async with its own timeout so slow DBs surface
  // as operational logs, not a deploy failure.
  const BOOT_DB_WATCHDOG_MS = 45_000;
  let dbBootDone = false;
  const dbBoot = (async () => {
    logger.info('[Boot] Postgres/cold-restore phase starting (port already bound)');
    const restore = await restoreFromDbIfCold();
    if (restore.restored > 0) {
      logger.success(`[CloudPersistence] Restored ${restore.restored} artifacts from DB on cold boot`);
    }
    await tradingEngine.init();
    continuousLearning.start();
    dbBootDone = true;
    logger.success('LiquiBot backend v4.0 LIVE on port', PORT);
    logger.info('Monitoring + continuous learning active');
    if (process.env.NODE_ENV === 'production') {
      logger.info('[CloudPersistence] Running in production — models/scalers/datasets dual-written to FS + DB');
      setTimeout(() => snapshotAllToDb().catch(() => {}), 10000);
    }
  })();
  const dbWatchdog = new Promise<never>((_, reject) => {
    const t = setTimeout(() => {
      clearTimeout(t);
      if (!dbBootDone) reject(new Error(`DB/cold-restore phase hung after ${BOOT_DB_WATCHDOG_MS}ms`));
    }, BOOT_DB_WATCHDOG_MS);
  });
  Promise.race([dbBoot, dbWatchdog]).catch((e) => {
    logger.error('[Boot] DB/cold-restore phase failed or hung — continuing with port bound (EA heartbeats still return commands via cache, no new trades)', { error: String(e) });
  });
}

startServer();
