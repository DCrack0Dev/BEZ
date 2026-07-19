import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { Server } from 'socket.io';
import http from 'http';
import dotenv from 'dotenv';
import { CONFIG } from './tradingConfig';
import { calculateRisk, RiskParams, TradeSignal } from './riskEngine';
import { initEmitter, emitSignal, emitStopUpdate, emitScaleInTrigger } from './signalEmitter';
import { validateSignal, Candle, MT5Payload, calculateATR, calculateSwingHighs, calculateSwingLows, calculateEMA } from './signalValidator';
import { processTrailingStop, PositionState } from './trailingStopManager';
import { Decimal } from 'decimal.js';
import { v4 as uuidv4 } from 'uuid';
import { FeatureEngineeringEngine, FeatureSet } from './features/featureEngine';
import { TradeDnaEngine, TradeDNA } from './dna/tradeDna';
import { ExperienceEngine } from './experience/experienceEngine';

dotenv.config();

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 5000;

// --- MIDDLEWARE ---
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// --- INIT NEW ENGINES ---
const io = initEmitter(server);
const featureEngine = new FeatureEngineeringEngine();
const dnaEngine = new TradeDnaEngine();
const experienceEngine = new ExperienceEngine();

// --- STATE ---
interface AccountState {
  balance: number;
  equity: number;
  positions: any[];
  ea_connected: boolean;
  symbol: string;
  price: number;
  spread: number;
  chart: Record<string, Candle[]>;
  lastUpdate: number;
  pipSize: number;
  pointSize: number;
  pipValue: number;
  minLot: number;
  maxLot: number;
  minLotStep: number;
  ema20: number;
  ema20Prev: number;
  ema50: number;
  atr14: number;
  candles: Candle[];
  autoTradingEnabled: boolean;
  lastFeatures?: FeatureSet;
}

let accountState: AccountState = {
  balance: 0,
  equity: 0,
  positions: [],
  ea_connected: false,
  symbol: '',
  price: 0,
  spread: 0,
  chart: {},
  lastUpdate: 0,
  pipSize: 0.01,
  pointSize: 0.001,
  pipValue: 1,
  minLot: 0.01,
  maxLot: 100,
  minLotStep: 0.01,
  ema20: 0,
  ema20Prev: 0,
  ema50: 0,
  atr14: 0,
  candles: [],
  autoTradingEnabled: false,
};

let pendingCommands: any[] = [];
let closedTrades: any[] = [];
let positionStates: Record<string, PositionState> = {}; // ticket -> position state for trailing stops
let lastTradeTime = 0;
let cooldowns: Record<'BUY' | 'SELL', number> = { BUY: 0, SELL: 0 };
let openPositionTickets = new Set<string>();

// --- LOGGING HELPER ---
const log = (msg: string) => {
  const t = new Date().toLocaleTimeString();
  console.log(`[${t}] ${msg}`);
};

// --- ROUTES ---

// Health Check for Render
app.get('/test', (req, res) => {
  res.status(200).send('OK');
});

// EA Validation
app.post('/api/ea/validate', (req, res) => {
  const { apiKey } = req.body;
  log(`🔑 Auth Request: ${apiKey}`);
  
  if (apiKey === 'FXSK-90e36448c3d1ef9d749aa155ba228541' || apiKey?.startsWith('FXSK-')) {
    log(`✅ Auth Success: ${apiKey}`);
    return res.json({
      valid: true,
      token: 'sk_live_' + Buffer.from(apiKey || '').toString('base64'),
      expiry: '2027-12-31',
      plan: 'Lifetime Pro',
      maxTrades: 15,
      maxOpenTrades: 15,
    });
  }
  
  log(`❌ Auth Failed: ${apiKey}`);
  res.status(401).json({ valid: false, message: 'Invalid API Key' });
});

// EA Update (Heartbeat) - BACKEND BRAIN
app.post('/api/ea/update', (req, res) => {
  const data = req.body as MT5Payload & { [key: string]: any };
  
  if (!data.symbol) {
    return res.status(400).json({ error: 'Missing symbol' });
  }

  // Extract and normalize candles
  let candles: Candle[] = data.candles || [];
  if (data.chart && typeof data.chart === 'object' && !Array.isArray(data.chart)) {
    candles = data.chart['M5'] || candles;
  }
  const sortedCandles = [...candles].sort((a, b) => (b.x || b.timestamp) - (a.x || a.timestamp));
  const candlesReversed = [...sortedCandles].reverse();

  // Calculate indicators
  const ema20 = data.ema20 || calculateEMA(candlesReversed, 20);
  const ema50 = data.ema50 || calculateEMA(candlesReversed, 50);
  const atr14 = data.atr14 || calculateATR(candlesReversed, 14);

  // 🧬 Generate Features
  const features = featureEngine.generateFeatures(
    data.symbol,
    candlesReversed,
    ema20,
    ema50,
    atr14,
    data.spread || 0,
    data.pipSize || 0.01
  );
  log(`🧬 Generated features: ${features.trendDirection} | ${features.marketSession}`);

  // Handle Closed Trades → Finalize DNA
  const currentTickets = new Set((data.positions || data.openPositions || []).map(p => String(p.ticket)));
  for (const ticket of openPositionTickets) {
    if (!currentTickets.has(ticket)) {
      openPositionTickets.delete(ticket);
      const closedTrade = (data.closedTrades || []).find((t: any) => String(t.ticket) === ticket);
      
      const dna = dnaEngine.getDnaByTicket(ticket);
      if (dna) {
        const lessons = experienceEngine.analyzeTrade(dna);
        const profitPips = closedTrade?.profit || 0;
        dnaEngine.finalizeTradeDNA(
          ticket,
          closedTrade?.closePrice || accountState.price,
          features,
          profitPips,
          0,
          0,
          lessons.map(l => l.title),
          lessons.map(l => l.description)
        );
      }
    }
  }

  // Handle Closed Trades Sync
  if (data.closedTrades && Array.isArray(data.closedTrades)) {
    data.closedTrades.forEach((t: any) => {
      if (!closedTrades.find(existing => existing.ticket === t.ticket)) {
        closedTrades.unshift(t);
        log(`💰 Closed Trade Recorded: #${t.ticket} | Profit: ${t.profit}`);
        delete positionStates[t.ticket];
        if (t.profit < 0) {
          const dir = (t.type === 'BUY' || t.type === 0) ? 'BUY' : 'SELL';
          cooldowns[dir] = Math.max(Date.now(), cooldowns[dir]) + 300000; // 5 min cooldown
          log(`⏳ Cooldown active for ${dir} due to loss`);
        }
      }
    });
    if (closedTrades.length > 100) closedTrades = closedTrades.slice(0, 100);
  }

  // Update Account State
  accountState = {
    ...accountState,
    ...data,
    positions: data.positions || data.openPositions || [],
    chart: { 
      'M5': sortedCandles,
      ...(data.chart && typeof data.chart === 'object' ? data.chart : {}),
    },
    ea_connected: true,
    lastUpdate: Date.now(),
    pipSize: data.pipSize || 0.01,
    pointSize: data.pointSize || 0.001,
    pipValue: data.pipValue || 1,
    minLot: data.minLot || 0.01,
    maxLot: data.maxLot || 100,
    minLotStep: data.minLotStep || 0.01,
    ema20,
    ema20Prev: data.ema20Prev || ema20,
    ema50,
    atr14,
    candles: sortedCandles,
    lastFeatures: features,
  };

  log(`💓 Heartbeat: ${accountState.symbol} | Price: ${accountState.price} | Positions: ${accountState.positions.length}`);

  // 🧬 Initialize DNA for new open positions
  for (const pos of accountState.positions) {
    const ticket = String(pos.ticket);
    if (!openPositionTickets.has(ticket)) {
      openPositionTickets.add(ticket);
      dnaEngine.initializeTradeDNA(
        ticket,
        accountState.symbol,
        (pos.type === 'BUY' || pos.type === 0) ? 'BUY' : 'SELL',
        pos.openPrice || pos.price || accountState.price,
        pos.sl || 0,
        pos.tp || 0,
        pos.volume || pos.lots || 0.01,
        1.0,
        features
      );
    }
  }

  // --- BACKEND BRAIN: 1. Trailing Stop Management ---
  for (const pos of accountState.positions) {
    const ticket = String(pos.ticket);
    if (!positionStates[ticket]) {
      positionStates[ticket] = {
        ticket,
        signalId: uuidv4(),
        symbol: pos.symbol || accountState.symbol,
        direction: (pos.type === 'BUY' || pos.type === 0) ? 'BUY' : 'SELL',
        openPrice: pos.openPrice || pos.price || accountState.price,
        currentSL: pos.sl || 0,
        currentPrice: accountState.price,
        phase: 1,
        scaleInLevels: [],
        tpLevels: [],
        spread: accountState.spread,
        pipSize: accountState.pipSize,
        pointSize: accountState.pointSize,
      };
    } else {
      positionStates[ticket].currentPrice = accountState.price;
    }

    const tsUpdate = processTrailingStop(positionStates[ticket]);
    if (tsUpdate) {
      log(`🛡️ Trailing Stop Update for #${ticket}: SL ${positionStates[ticket].currentSL} → ${tsUpdate.newSL}, Phase ${tsUpdate.phase}`);
      positionStates[ticket].currentSL = tsUpdate.newSL;
      positionStates[ticket].phase = tsUpdate.phase;
      pendingCommands.push({
        action: 'UPDATE_SL',
        ticket,
        sl: tsUpdate.newSL,
      });
      emitStopUpdate({
        positionTicket: ticket,
        newStopLoss: tsUpdate.newSL,
        phase: tsUpdate.phase,
        isRiskFree: tsUpdate.phase >= 2,
        direction: positionStates[ticket].direction,
      });
    }
  }

  // --- BACKEND BRAIN: 2. Signal Validation & Auto Trading ---
  if (accountState.autoTradingEnabled) {
    const swingHighs = data.swingHighs || calculateSwingHighs(candlesReversed, 2);
    const swingLows = data.swingLows || calculateSwingLows(candlesReversed, 2);
    const signalPayload: MT5Payload = {
      ...data,
      symbol: accountState.symbol,
      timeframe: 'M5',
      candles: candlesReversed,
      spread: accountState.spread,
      balance: accountState.balance,
      equity: accountState.equity,
      pipSize: accountState.pipSize,
      pointSize: accountState.pointSize,
      pipValue: accountState.pipValue,
      minLot: accountState.minLot,
      maxLot: accountState.maxLot,
      minLotStep: accountState.minLotStep,
      swingHighs,
      swingLows,
      openPositionsCount: accountState.positions.length,
      ema20,
      ema20Prev: accountState.ema20Prev,
      atr14,
    };

    const signal = validateSignal(signalPayload);
    if (signal) {
      const now = Date.now();
      if (now - lastTradeTime > 30000 && now > cooldowns[signal.direction]) {
        log(`🚀 AUTO SIGNAL: ${signal.direction} ${signal.symbol}`);
        emitSignal(signal);
        pendingCommands.push({
          action: signal.direction,
          symbol: signal.symbol,
          lots: signal.lotSizes?.entry1 || 0.01,
          sl: signal.stopLoss,
          tp: signal.takeProfitLevels?.[0] || 0,
        });
        lastTradeTime = now;
      }
    }
  }

  // Push state to mobile app
  io.emit('EA_HEARTBEAT', {
    ...accountState,
    lastSignalReason: `Trend: ${features.trendDirection} | Session: ${features.marketSession} | Volatility: ${features.volatility}`
  });

  res.json({ success: true, commands: [] });
});

// EA Command Polling
app.get('/api/ea/commands', (req, res) => {
  const cmds = [...pendingCommands];
  pendingCommands = [];
  if (cmds.length > 0) log(`📡 Polled ${cmds.length} commands`);
  res.json(cmds);
});

// App Account Data
app.get('/api/account', (req, res) => {
  res.json(accountState);
});

// App Closed Trades
app.get('/api/orders/closed', (req, res) => {
  const filter = req.query.filter as string;
  let filtered = [...closedTrades];
  if (filter === 'today') {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    filtered = closedTrades.filter(t => new Date((t.time || t.closeTime) * 1000) >= today);
  } else if (filter === 'week') {
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    filtered = closedTrades.filter(t => new Date((t.time || t.closeTime) * 1000) >= weekAgo);
  }
  res.json(filtered);
});

// App Order Relay
app.post('/api/order', (req, res) => {
  log(`📥 App Order: ${req.body.action} ${req.body.symbol}`);
  if (req.body.action === 'RESUME' || req.body.action === 'PAUSE') {
    accountState.autoTradingEnabled = req.body.action === 'RESUME';
    log(`⚙️ Auto Trading ${accountState.autoTradingEnabled ? 'ENABLED' : 'DISABLED'}`);
  } else {
    pendingCommands.push(req.body);
  }
  res.json({ success: true });
});

// Bot Config Sync
app.post('/api/bot/config', (req, res) => {
  log(`⚙️ Bot Config Sync: ${JSON.stringify(req.body)}`);
  if (req.body.autoTradingEnabled !== undefined) {
    accountState.autoTradingEnabled = req.body.autoTradingEnabled;
  }
  pendingCommands.push({ action: 'CONFIG_SYNC', ...req.body });
  res.json({ success: true });
});

// New API: Get Trade DNA
app.get('/api/dna', (req, res) => {
  res.json(dnaEngine.getAllDna());
});

// New API: Get Lessons
app.get('/api/lessons', (req, res) => {
  res.json(experienceEngine.getLessons());
});

// New API: Get Model Candidates
app.get('/api/models', (req, res) => {
  res.json(experienceEngine.getModelCandidates());
});

// New API: Get Current Features
app.get('/api/features', (req, res) => {
  res.json(accountState.lastFeatures || {});
});

// App Subscription (dummy endpoint for compatibility)
app.get('/api/subscription', (req, res) => {
  res.json({
    active: true,
    plan: 'Lifetime Pro',
    expiry: '2027-12-31',
  });
});

server.listen(PORT, () => {
  log(`🚀 Backend v4.0 LIVE on port ${PORT} (Full Brain Mode + DNA + Features + Experience)`);
});
