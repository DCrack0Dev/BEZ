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
  const { accountData, positions, chart, logs, apiKey } = req.body;
  
  if (accountData) {
    accountState = {
      ...accountState,
      ...accountData,
      positions: positions || accountState.positions,
      chart: chart || accountState.chart,
      ea_connected: true,
      lastEaUpdate: Date.now()
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
        pipSize: 0.0001, // Should be dynamic
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

  const commands = [...pendingCommands];
  pendingCommands = [];
  
  res.json({ commands });
});

// --- APP ENDPOINTS ---

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

  // Build payload for validator
  const payload: MT5Payload = {
    symbol: accountState.eaSymbol || 'BTCUSD',
    timeframe: 'M5',
    candles: accountState.chart['M5'] || [],
    spread: accountState.spread,
    balance: accountState.balance,
    equity: accountState.equity,
    pipSize: 0.0001,
    pointSize: 0.01,
    pipValue: 10,
    minLot: 0.01,
    maxLot: 100,
    minLotStep: 0.01,
    swingHighs: [],
    swingLows: [],
    openPositionsCount: accountState.positions.length,
    ema20: 0,
    ema20Prev: 0,
    atr14: 0,
    newsFilterActive: false
  };

  const signal = validateSignal(payload);
  if (signal) {
    emitSignal(signal as any);
  }
}, CONFIG.commandPollIntervalMs);

server.listen(PORT, () => {
  loadClosedTradesFromDisk();
  console.log(`🚀 Server running on port ${PORT}`);
});
