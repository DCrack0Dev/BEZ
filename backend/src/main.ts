import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import fs from 'fs';
import path from 'path';
import { Server } from 'socket.io';
import http from 'http';
import dotenv from 'dotenv';
import { CONFIG } from './tradingConfig';
import { validateSignal, MT5Payload } from './signalValidator';
import { processTrailingStop, PositionState } from './trailingStopManager';
import { initEmitter, emitSignal, emitStopUpdate, emitScaleInTrigger } from './signalEmitter';

dotenv.config();

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 5000;
const DATA_DIR = path.join(__dirname, '..', 'data');
const CLOSED_TRADES_FILE = path.join(DATA_DIR, 'closed-trades.json');

// Initialize WebSocket
initEmitter(server);

app.use(cors());
app.use(bodyParser.json());

// In-memory state
let accountState: any = {
  balance: 200000,
  equity: 200000,
  positions: [],
  lastSeen: new Date().toISOString(),
  lastEaUpdate: 0,
  profit: 0,
  pnl_today: 0,
  ea_connected: false,
  eaSymbol: 'BTCUSD',
  currency: 'USD',
  price: 0,
  spread: 0,
  chart: {},
  structures: {},
  logs: []
};

let pendingCommands: any[] = [];
let closedTrades: any[] = [];

// --- PERSISTENCE ---

function saveClosedTradesToDisk() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CLOSED_TRADES_FILE, JSON.stringify(closedTrades.slice(0, 500), null, 2), 'utf8');
  } catch (err: any) {
    console.error('[PERSIST] Failed to save trades:', err.message);
  }
}

function loadClosedTradesFromDisk() {
  try {
    if (fs.existsSync(CLOSED_TRADES_FILE)) {
      const raw = fs.readFileSync(CLOSED_TRADES_FILE, 'utf8');
      closedTrades = JSON.parse(raw);
    }
  } catch (err: any) {
    console.error('[PERSIST] Failed to load trades:', err.message);
  }
}

// --- EA ENDPOINTS ---

app.post('/api/ea/update', (req, res) => {
  const data = req.body;
  const apiKey = data.apiKey;
  
  // Accept both nested accountData and flat root fields (compatible with all EA versions)
  const accountData = data.accountData || data;
  const positions = data.positions || data.openPositions || [];
  const chart = data.chart || {};

  if (accountData.symbol || accountData.balance) {
    console.log(`[EA] 💓 Heartbeat from ${accountData.symbol || accountData.eaSymbol} | Price: ${accountData.price} | Spread: ${accountData.spread}`);
    
    accountState = {
      ...accountState,
      ...accountData,
      symbol: accountData.symbol || accountData.eaSymbol, // Ensure symbol is mapped for App
      positions: positions,
      chart: chart,
      ea_connected: true,
      lastEaUpdate: Date.now(),
      lastSeen: new Date().toISOString()
    };

    // Run Trailing Stop Manager for each position
    accountState.positions.forEach((pos: any) => {
      const state: PositionState = {
        ticket: pos.ticket,
        signalId: pos.signalId || '',
        symbol: pos.symbol,
        direction: pos.type as 'BUY' | 'SELL',
        openPrice: pos.openPrice || pos.price,
        currentSL: pos.sl,
        currentPrice: accountState.price,
        phase: pos.phase || 1,
        scaleInLevels: pos.scaleInLevels || [],
        tpLevels: pos.tpLevels || [],
        spread: accountState.spread,
        pipSize: 0.0001, 
        pointSize: 0.01
      };

      const update = processTrailingStop(state);
      if (update) {
        pendingCommands.push({
          action: 'MODIFY_SL',
          ticket: pos.ticket,
          sl: update.newSL
        });
        emitStopUpdate({
          positionTicket: pos.ticket,
          newStopLoss: update.newSL,
          phase: update.phase as any,
          isRiskFree: update.phase >= 2,
          direction: pos.type
        });
      }
    });
  }

  res.json({ success: true });
});

app.get('/api/ea/commands', (req, res) => {
  const commands = [...pendingCommands];
  pendingCommands = [];
  res.json(commands);
});

// --- APP ENDPOINTS ---

app.post('/api/ea/validate', (req, res) => {
  const { apiKey } = req.body;
  console.log(`[AUTH] 🔑 Validating API Key: ${apiKey}`);

  if (apiKey && apiKey.startsWith('FXSK-')) {
    res.json({
      valid: true,
      token: 'sk_live_' + Buffer.from(apiKey).toString('base64'),
      expiry: '2027-12-31',
      plan: 'Lifetime Pro'
    });
  } else {
    res.status(401).json({
      valid: false,
      message: 'Invalid API Key format. Must start with FXSK-'
    });
  }
});

app.get('/api/account', (req, res) => {
  res.json(accountState);
});

app.post('/api/order', (req, res) => {
  pendingCommands.push(req.body);
  res.json({ success: true });
});

// --- BRAIN LOOP ---

setInterval(() => {
  if (!accountState.ea_connected) return;

  const currentSymbol = accountState.symbol || accountState.eaSymbol;
  const currentChart = accountState.chart['M5'] || accountState.chart['PERIOD_M5'] || [];

  if (currentChart.length < 20) {
    if (Date.now() % 60000 < 5000) console.log(`[BRAIN] ⚠️ Waiting for more chart data... (${currentChart.length}/20 candles)`);
    return;
  }

  // Build payload for validator
  const payload: MT5Payload = {
    symbol: currentSymbol,
    timeframe: 'M5',
    candles: currentChart,
    spread: accountState.spread || 0,
    balance: accountState.balance || 0,
    equity: accountState.equity || 0,
    pipSize: accountState.pipSize || 0.0001,
    pointSize: accountState.pointSize || 0.01,
    pipValue: accountState.pipValue || 10,
    minLot: accountState.minLot || 0.01,
    maxLot: accountState.maxLot || 100,
    minLotStep: accountState.minLotStep || 0.01,
    swingHighs: accountState.swingHighs || [],
    swingLows: accountState.swingLows || [],
    openPositionsCount: accountState.positions.length,
    ema20: accountState.ema20 || 0,
    ema20Prev: accountState.ema20Prev || 0,
    atr14: accountState.atr14 || 0,
    newsFilterActive: accountState.newsFilterActive || false
  };

  const signal = validateSignal(payload);
  if (signal) {
    console.log(`[BRAIN] 🎯 SIGNAL GENERATED: ${signal.direction} ${signal.symbol} @ ${signal.entryPrice}`);
    emitSignal(signal as any);
  }
}, CONFIG.commandPollIntervalMs);

server.listen(PORT, () => {
  loadClosedTradesFromDisk();
  console.log(`🚀 Server running on port ${PORT}`);
});
