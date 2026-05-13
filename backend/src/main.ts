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
import { initEmitter, emitSignal, emitStopUpdate } from './signalEmitter';

dotenv.config();

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// Initialize WebSocket
initEmitter(server);

// State
let accountState: any = {
  balance: 0,
  equity: 0,
  positions: [],
  ea_connected: false,
  symbol: '',
  price: 0,
  spread: 0,
  chart: {},
  lastUpdate: 0
};

let pendingCommands: any[] = [];

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
      plan: 'Lifetime Pro'
    });
  }
  
  log(`❌ Auth Failed: ${apiKey}`);
  res.status(401).json({ valid: false, message: 'Invalid API Key' });
});

// EA Update (Heartbeat)
app.post('/api/ea/update', (req, res) => {
  const data = req.body;
  
  if (!data.symbol) {
    return res.status(400).json({ error: 'Missing symbol' });
  }

  // Update State
  accountState = {
    ...accountState,
    ...data,
    positions: data.openPositions || [],
    chart: { 'M5': data.candles || [] },
    ea_connected: true,
    lastUpdate: Date.now()
  };

  log(`💓 Heartbeat: ${data.symbol} | Price: ${data.price} | Positions: ${accountState.positions.length}`);

  // Process Trailing Stops
  accountState.positions.forEach((pos: any) => {
    const state: PositionState = {
      ticket: pos.ticket,
      signalId: '',
      symbol: data.symbol,
      direction: pos.type,
      openPrice: pos.price,
      currentSL: pos.sl,
      currentPrice: data.price,
      phase: 1,
      scaleInLevels: [],
      tpLevels: [],
      spread: data.spread,
      pipSize: 0.0001,
      pointSize: 0.01
    };
    
    const update = processTrailingStop(state);
    if (update) {
      log(`🛡️ Trail Update: #${pos.ticket} -> SL: ${update.newSL}`);
      pendingCommands.push({ action: 'MODIFY_SL', ticket: pos.ticket, sl: update.newSL });
      emitStopUpdate({
        positionTicket: String(pos.ticket),
        newStopLoss: update.newSL,
        phase: update.phase as any,
        isRiskFree: update.phase >= 2,
        direction: pos.type
      });
    }
  });

  res.json({ success: true });
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

// App Manual Order
app.post('/api/order', (req, res) => {
  log(`📥 App Order: ${req.body.action} ${req.body.symbol}`);
  pendingCommands.push(req.body);
  res.json({ success: true });
});

// --- BRAIN SCAN ---
setInterval(() => {
  if (!accountState.ea_connected || !accountState.chart['M5'] || accountState.chart['M5'].length < 100) return;

  const m5Candles = accountState.chart['M5'];
  
  // Dynamic Swing Highs/Lows calculation for Key Levels (using 48h data)
  const highs = m5Candles.map((c: any) => c.high);
  const lows = m5Candles.map((c: any) => c.low);
  
  const swingHighs = [
    Math.max(...highs.slice(-100)), // Recent 8h
    Math.max(...highs.slice(-300)), // Recent 24h
    Math.max(...highs.slice(-576))  // Full 48h
  ].filter(v => !isNaN(v));

  const swingLows = [
    Math.min(...lows.slice(-100)),
    Math.min(...lows.slice(-300)),
    Math.min(...lows.slice(-576))
  ].filter(v => !isNaN(v));

  const payload: MT5Payload = {
    symbol: accountState.symbol,
    timeframe: 'M5',
    candles: m5Candles,
    spread: accountState.spread,
    balance: accountState.balance,
    equity: accountState.equity,
    pipSize: accountState.pipSize || 0.0001,
    pointSize: accountState.pointSize || 0.01,
    pipValue: accountState.pipValue || 10,
    minLot: accountState.minLot || 0.01,
    maxLot: accountState.maxLot || 100,
    minLotStep: accountState.minLotStep || 0.01,
    swingHighs,
    swingLows,
    openPositionsCount: accountState.positions.length,
    ema20: accountState.ema20 || 0,
    ema20Prev: accountState.ema20Prev || 0,
    atr14: accountState.atr14 || 0,
    newsFilterActive: false
  };

  const signal = validateSignal(payload);
  if (signal) {
    log(`🎯 SIGNAL: ${signal.direction} ${signal.symbol} @ ${signal.entryPrice}`);
    emitSignal(signal as any);
  }
}, 1000);

server.listen(PORT, () => {
  log(`🚀 Backend Brain v2.12 Live on port ${PORT}`);
});
