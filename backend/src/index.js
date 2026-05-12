const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;
const SIGNAL_SCAN_INTERVAL_MS = Number(process.env.SIGNAL_SCAN_INTERVAL_MS || 2000);
const BACKEND_BRAIN_DEFAULT_MODE = String(process.env.BACKEND_BRAIN_DEFAULT_MODE || 'app').toLowerCase();

// In-memory account state - starts empty, populated by EA
let accountState = {
  balance: 200000,
  equity: 200000,
  positions: [],
  lastSeen: new Date().toISOString(),
  lastEaUpdate: 0, // Timestamp of last EA heartbeat
  profit: 0,
  pnl_today: 0,
  ea_connected: false,
  eaSymbol: 'BTCUSD',
  currency: 'USD',
  price: 4565.58,
  fastEMA: 0,
  slowEMA: 0,
  bbUpper: 0,
  bbLower: 0,
  rsi: 0,
  atr: 0,
  vwap: 0,
  spread: 0,
  tickVolume: 0,
  chart: {},
  structures: {},
  keyLevelInfo: null,
  logs: [], // Store logs from EA
};
let closedTrades = [];
const DATA_DIR = path.join(__dirname, '..', 'data');
const CLOSED_TRADES_FILE = path.join(DATA_DIR, 'closed-trades.json');
let botControl = {
  autoTradingEnabled: false,
  executionMode: BACKEND_BRAIN_DEFAULT_MODE === 'backend' ? 'backend' : 'app', // 'app' | 'backend'
  defaultLots: 0.01,
  maxOpenTrades: 5,
  trailingStopEnabled: true,
  lastActionAt: 0,
  lastSignal: 'NONE',
  pendingSignal: null
};

function toFiniteNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function inferCloseReasonFromPrices(type, closePrice, sl, tp, fallback = 'MANUAL') {
  const normalizedType = String(type || 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
  const threshold = Math.max(Math.abs(closePrice) * 0.0002, 0.05);
  if (sl > 0 && Math.abs(closePrice - sl) <= threshold) return 'SL';
  if (tp > 0 && Math.abs(closePrice - tp) <= threshold) return 'TP';
  if (normalizedType === 'BUY' && sl > 0 && closePrice < sl) return 'SL';
  if (normalizedType === 'SELL' && sl > 0 && closePrice > sl) return 'SL';
  if (normalizedType === 'BUY' && tp > 0 && closePrice > tp) return 'TP';
  if (normalizedType === 'SELL' && tp > 0 && closePrice < tp) return 'TP';
  return fallback;
}

function normalizeClosedTrade(raw = {}) {
  const ticket = String(raw.ticket || raw.id || '');
  const type = String(raw.type || 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
  const openPrice = toFiniteNumber(raw.openPrice, raw.priceOpen, raw.entryPrice, raw.price_open);
  const closePrice = toFiniteNumber(raw.closePrice, raw.priceClose, raw.exitPrice, raw.price_close, raw.price, accountState.price);
  const sl = toFiniteNumber(raw.sl, raw.stopLoss, raw.stop_loss);
  const tp = toFiniteNumber(raw.tp, raw.takeProfit, raw.take_profit);
  const lots = toFiniteNumber(raw.lots, raw.volume, raw.lotSize, raw.size);
  const profit = toFiniteNumber(raw.profit, raw.pnl);
  const closeReason = String(raw.closeReason || '').trim()
    || inferCloseReasonFromPrices(type, closePrice, sl, tp, 'MANUAL');

  return {
    id: String(raw.id || `${ticket || 'unknown'}-${Date.now()}`),
    ticket,
    symbol: raw.symbol || accountState.eaSymbol || 'BTCUSD',
    type,
    profit,
    pnl: profit,
    lots,
    openPrice,
    closePrice,
    sl,
    tp,
    closeReason,
    openTime: raw.openTime || raw.open_time || raw.timeOpen || new Date().toISOString(),
    closeTime: raw.closeTime || raw.close_time || raw.timeClose || new Date().toISOString(),
    date: raw.date || raw.closeTime || raw.close_time || new Date().toISOString(),
  };
}

function loadClosedTradesFromDisk() {
  try {
    if (!fs.existsSync(CLOSED_TRADES_FILE)) {
      closedTrades = [];
      return;
    }

    const raw = fs.readFileSync(CLOSED_TRADES_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : [];
    closedTrades = arr.map((t) => normalizeClosedTrade(t)).slice(0, 500);
    console.log(`[PERSIST] Loaded ${closedTrades.length} closed trades from disk`);
  } catch (err) {
    console.error('[PERSIST] Failed to load closed trades:', err.message);
    closedTrades = [];
  }
}

function saveClosedTradesToDisk() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const normalized = (closedTrades || []).map((t) => normalizeClosedTrade(t)).slice(0, 500);
    fs.writeFileSync(CLOSED_TRADES_FILE, JSON.stringify(normalized, null, 2), 'utf8');
  } catch (err) {
    console.error('[PERSIST] Failed to save closed trades:', err.message);
  }
}

app.use(cors());
app.use(bodyParser.json());

function buildCommandString(action, payload = {}) {
  const { sl, tp, ticket, top, bottom, zoneType, time, price, levelType } = payload;
  switch (action) {
    case 'BUY':
      return `BUY|${sl || 0}|${tp || 0}`;
    case 'SELL':
      return `SELL|${sl || 0}|${tp || 0}`;
    case 'CLOSE_TRADE':
      return `CLOSE_TICKET_${ticket}`;
    case 'CLOSE_ALL':
      return 'CLOSE_ALL';
    case 'MODIFY_SL':
      return `MODIFY_SL|${ticket}|${sl || 0}|${tp || 0}`;
    case 'DRAW_OB':
      return `DRAW_OB|${top}|${bottom}|${zoneType || 'BULLISH'}|${time || 0}`;
    case 'DRAW_FVG':
      return `DRAW_FVG|${top}|${bottom}|${zoneType || 'BULLISH'}|${time || 0}`;
    case 'DRAW_KEY_LEVEL':
      return `DRAW_KEY_LEVEL|${price}|${levelType || 'support'}`;
    case 'RESUME':
      return 'RESUME';
    case 'PAUSE':
      return 'PAUSE';
    default:
      return '';
  }
}

function queueCommand(action, payload = {}) {
  const commandString = buildCommandString(action, payload);
  if (!commandString) return false;
  pendingCommands.push({
    action,
    command: commandString,
    symbol: payload.symbol || accountState.eaSymbol || 'BTCUSD',
    lots: payload.lots || botControl.defaultLots || 0.01,
    sl: payload.sl || 0,
    tp: payload.tp || 0,
    ticket: payload.ticket,
    createdAt: new Date().toISOString()
  });
  return true;
}

// Test endpoint
app.get('/test', (req, res) => {
  res.json({ message: 'Backend is running', timestamp: new Date().toISOString() });
});

// EA validation endpoint
app.post('/api/ea/validate', (req, res) => {
  const { apiKey } = req.body;
  console.log(`[EA] 🔑 License validation request for key: ${apiKey}`);
  
  // Simple validation - accept any key starting with FXSK-
  if (apiKey && apiKey.startsWith('FXSK-')) {
    console.log(`[EA] ✅ License validated for key: ${apiKey}`);
    const maxOpenTrades = 5;
    res.json({
      valid: true,
      token: 'mock-jwt-token-' + Date.now(),
      expiry: '2026-12-31',
      plan: 'PAID',
      features: {
        maxTrades: maxOpenTrades,
        maxOpenTrades,
        trailingStop: true,
        sessionFilter: true
      }
    });
  } else {
    res.status(401).json({ valid: false, message: 'Invalid API key' });
  }
});

// EA heartbeat endpoint - receives real data from EA
app.post('/api/ea/update', (req, res) => {
  const { accountData, testStructures, structures, positions, chart, logs: eaLogs, apiKey } = req.body;
  console.log(`[EA] ❤️ Heartbeat received from ${apiKey || 'unknown EA'}`);
  
  // Update account state with real EA data
  if (accountData) {
    const prevPositions = Array.isArray(accountState.positions) ? [...accountState.positions] : [];
    const prevBalance = accountState.balance;
    const prevEquity = accountState.equity;
    const prevPrice = accountState.price;
    
    accountState.balance = accountData.balance || accountState.balance;
    accountState.equity = accountData.equity || accountState.balance;
    accountState.price = accountData.price || accountState.price;
    accountState.currency = accountData.currency || accountState.currency || 'USD';
    // MT5 EA sends positions at top-level; keep accountData fallback for compatibility
    accountState.positions = positions || accountData.positions || accountState.positions;
    accountState.ea_connected = true;
    accountState.lastEaUpdate = Date.now();
    accountState.lastSeen = new Date().toISOString();
    accountState.eaSymbol = accountData.eaSymbol || accountData.symbol || accountState.eaSymbol || 'BTCUSD';
    accountState.fastEMA = accountData.fastEMA || 0;
    accountState.slowEMA = accountData.slowEMA || 0;
    accountState.bbUpper = accountData.bbUpper || 0;
    accountState.bbLower = accountData.bbLower || 0;
    accountState.rsi = accountData.rsi || 0;
    accountState.atr = accountData.atr || 0;
    accountState.vwap = accountData.vwap || 0;
    accountState.spread = accountData.spread || 0;
    accountState.tickVolume = accountData.tickVolume || 0;
    accountState.chart = chart || accountData.chart || accountState.chart || {};

    // Detect closed trades by position delta between heartbeats.
    const currentPositions = Array.isArray(accountState.positions) ? accountState.positions : [];
    const currentTickets = new Set(currentPositions.map((p) => String(p.ticket)));
    prevPositions.forEach((p) => {
      const ticket = String(p.ticket);
      if (!currentTickets.has(ticket)) {
        const closeTimeIso = new Date().toISOString();
        const openTimeIso = p.time ? new Date(Number(p.time) * 1000).toISOString() : closeTimeIso;
        const closePrice = toFiniteNumber(accountData.price, accountState.price);
        const sl = toFiniteNumber(p.sl, p.stopLoss, p.stop_loss);
        const tp = toFiniteNumber(p.tp, p.takeProfit, p.take_profit);
        const normalized = normalizeClosedTrade({
          id: `${ticket}-${Date.now()}`,
          ticket,
          symbol: p.symbol || accountState.eaSymbol || 'BTCUSD',
          type: p.type || 'BUY',
          profit: toFiniteNumber(p.profit),
          lots: toFiniteNumber(p.volume, p.lots),
          openPrice: toFiniteNumber(p.openPrice, p.price, p.entryPrice),
          closePrice,
          sl,
          tp,
          closeReason: inferCloseReasonFromPrices(p.type, closePrice, sl, tp, 'MANUAL'),
          openTime: openTimeIso,
          closeTime: closeTimeIso,
          date: closeTimeIso,
        });
        closedTrades.unshift(normalized);
      }
    });
    if (closedTrades.length > 500) closedTrades = closedTrades.slice(0, 500);
    saveClosedTradesToDisk();
    
    // Enhanced logging
    console.log(` [Backend] Market Data - Price: ${accountState.price} | EMA: ${accountState.fastEMA}/${accountState.slowEMA} | RSI: ${accountState.rsi}`);
    console.log(` [Backend] Account - Balance: ${accountState.currency}${accountState.balance} | Equity: ${accountState.currency}${accountState.equity} | Positions: ${accountState.positions.length}`);
    
    // Store structures from EA (supports both payload keys)
    const incomingStructures = structures || testStructures;
    if (incomingStructures && typeof incomingStructures === 'object' && Object.keys(incomingStructures).length > 0) {
      accountState.structures = incomingStructures;
      console.log(` [Backend] Structures updated from EA - Timeframes: ${Object.keys(incomingStructures).join(', ')}`);
    } else if (accountState.chart && Object.keys(accountState.chart).length > 0) {
      // Fallback: Generate basic structures from chart data if EA doesn't send them
      accountState.structures = generateBasicStructures(accountState.chart);
      console.log(` [Backend] Structures generated from chart data`);
    }
    
    accountState.keyLevelInfo = null; // Key level info deprecated in favor of SMC structures

    // Add logs from EA
    if (Array.isArray(eaLogs)) {
      eaLogs.forEach(log => {
        accountState.logs.unshift({
          id: `${Date.now()}-${Math.random()}`,
          timestamp: new Date().toISOString(),
          component: 'EA',
          level: log.level || 'info',
          message: log.message,
          details: log.details
        });
      });
      if (accountState.logs.length > 200) accountState.logs = accountState.logs.slice(0, 200);
    }
    
    // Calculate real P&L from EA data (use realistic calculations)
    let totalProfit = 0;
    accountState.positions.forEach(pos => {
      if (pos.profit && typeof pos.profit === 'number') {
        // If EA provides profit, use it but ensure it's realistic
        let profit = pos.profit;
        // If profit seems too large, recalculate based on price difference
        if (Math.abs(profit) > 1000) {
          const currentPrice = accountState.price || 4565.58;
          const priceDiff = pos.type === 'BUY' 
            ? currentPrice - pos.openPrice 
            : pos.openPrice - currentPrice;
          profit = priceDiff * pos.volume * 100; // Realistic calculation
        }
        totalProfit += profit;
      } else {
        // Calculate profit if not provided
        const currentPrice = accountState.price || 4565.58;
        const priceDiff = pos.type === 'BUY' 
          ? currentPrice - pos.openPrice 
          : pos.openPrice - currentPrice;
        totalProfit += priceDiff * pos.volume * 100;
      }
    });
    accountState.profit = totalProfit;
    accountState.pnl_today = totalProfit;
    
    // Update equity properly (balance + floating P&L)
    accountState.equity = accountState.balance + totalProfit;
    
    // Log changes
    if (Math.abs(prevBalance - accountState.balance) > 0.01) {
      console.log(` [Backend] Balance changed: ${accountState.currency}${prevBalance} → ${accountState.currency}${accountState.balance}`);
    }
    if (Math.abs(prevEquity - accountState.equity) > 0.01) {
      console.log(` [Backend] Equity changed: ${accountState.currency}${prevEquity} → ${accountState.currency}${accountState.equity}`);
    }
    if (Math.abs(prevPrice - accountState.price) > 0.0001) {
      console.log(` [Backend] Price changed: ${prevPrice} → ${accountState.price}`);
    }
  }
  
  // Send pending commands to EA
  let commandsToSend = [];
  if (pendingCommands.length > 0) {
    commandsToSend = [...pendingCommands];
    pendingCommands = []; // Clear the queue
    console.log(`[BACKEND] Sending ${commandsToSend.length} commands to EA:`, commandsToSend.map(c => c.command).join(', '));
  }
  
  // Automatically add DRAW commands for all identified key levels in the current timeframe
  if (accountState.structures && accountState.structures['M5']) {
    const m5Levels = accountState.structures['M5'].keyLevels || [];
    m5Levels.forEach(lvl => {
      commandsToSend.push({
        action: 'DRAW_KEY_LEVEL',
        command: `DRAW_KEY_LEVEL|${lvl.price}|${lvl.type}`,
        price: lvl.price,
        levelType: lvl.type
      });
    });
  }
  
  res.json({
    ea_connected: true,
    lastSeen: new Date().toISOString(),
    currency: accountState.currency,
    structures: accountState.structures,
    keyLevelInfo: accountState.keyLevelInfo,
    logs: accountState.logs, // Send logs back to EA/App
    commands: commandsToSend, // EA parser expects command objects
    commandStrings: commandsToSend.map(cmd => cmd.command)
  });
});

function generateBasicStructures(charts) {
  const structures = {};
  const tfs = Object.keys(charts);
  
  tfs.forEach(tf => {
    const candles = charts[tf];
    if (!Array.isArray(candles) || candles.length < 20) return;
    
    const sorted = [...candles].sort((a, b) => a.x - b.x); // Oldest first
    
    // 1. Order Blocks
    const orderBlocks = [];
    for (let i = 1; i < sorted.length - 2; i++) {
      const c = sorted[i];
      const p1 = sorted[i+1];
      const body = Math.abs(c.close - c.open);
      const range = Math.max(c.high - c.low, 0.00001);
      if (body > range * 0.6) {
        const isBullish = c.close > c.open;
        orderBlocks.push({
          type: isBullish ? 'BULLISH' : 'BEARISH',
          top: c.high,
          bottom: c.low,
          time: c.x,
          label: `${tf} ${isBullish ? 'BULL' : 'BEAR'} OB`
        });
      }
    }

    // 2. Fair Value Gaps (FVG)
    const fvgs = [];
    for (let i = 2; i < sorted.length; i++) {
      const c1 = sorted[i-2];
      const c2 = sorted[i-1];
      const c3 = sorted[i];
      if (c1.high < c3.low) { // Bullish FVG
        fvgs.push({ type: 'BULLISH', top: c3.low, bottom: c1.high, time: c2.x });
      } else if (c1.low > c3.high) { // Bearish FVG
        fvgs.push({ type: 'BEARISH', top: c1.low, bottom: c3.high, time: c2.x });
      }
    }

    // 3. Market Structure (BOS/CHoCH)
    let trend = 'NEUTRAL';
    const ms = [];
    let lastHigh = sorted[0].high;
    let lastLow = sorted[0].low;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].close > lastHigh) {
        ms.push({ type: trend === 'BEARISH' ? 'CHoCH' : 'BOS', side: 'BULLISH', price: sorted[i].close, time: sorted[i].x });
        trend = 'BULLISH';
        lastHigh = sorted[i].high;
      } else if (sorted[i].close < lastLow) {
        ms.push({ type: trend === 'BULLISH' ? 'CHoCH' : 'BOS', side: 'BEARISH', price: sorted[i].close, time: sorted[i].x });
        trend = 'BEARISH';
        lastLow = sorted[i].low;
      }
    }
    
    structures[tf] = {
      orderBlocks: orderBlocks.slice(-5),
      fvgs: fvgs.slice(-5),
      marketStructure: ms.slice(-3),
      trend
    };
  });
  
  return structures;
}

function confirmationsPass(signal, klType, price) {
  const tf = klType.includes('H4') ? 'H4' : klType.includes('H1') ? 'H1' : klType.includes('M15') ? 'M15' : 'M5';
  const candles = getRecentCandles(tf, 5);
  if (candles.length < 2) return false;

  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  
  // Candlestick Patterns
  const body = Math.abs(last.close - last.open);
  const range = Math.max(0.00001, last.high - last.low);
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;

  if (signal === 'BUY') {
    const isHammer = lowerWick >= body * 2 && upperWick <= body * 0.5;
    const isEngulfing = last.close > prev.open && last.open < prev.close && last.close > last.open && prev.close < prev.open;
    return isHammer || isEngulfing;
  } else if (signal === 'SELL') {
    const isShootingStar = upperWick >= body * 2 && lowerWick <= body * 0.5;
    const isEngulfing = last.close < prev.open && last.open > prev.close && last.close < last.open && prev.close > prev.open;
    return isShootingStar || isEngulfing;
  }
  return false;
}

function runBackendBrain() {
  if (!accountState.ea_connected || !botControl.autoTradingEnabled || botControl.executionMode !== 'backend') return;

  const now = Date.now();
  if (now - botControl.lastActionAt < 3000) return;

  const positions = Array.isArray(accountState.positions) ? accountState.positions : [];
  const openCount = positions.length;
  const maxOpen = Math.max(1, Number(botControl.maxOpenTrades || 5));
  const price = Number(accountState.price || 0);
  const atr = Math.max(Number(accountState.atr || 0), 0.01);
  const spread = Number(accountState.spread || 0);
  const structures = accountState.structures || {};

  if (spread > 35 || !price) return;

  // 1. Trailing Stop Logic (KEEP)
  if (botControl.trailingStopEnabled && openCount > 0) {
    positions.forEach((pos) => {
      const profit = Number(pos.profit || 0);
      if (profit < 0.5) return;
      const isBuy = String(pos.type).toUpperCase() === 'BUY';
      const openPrice = Number(pos.openPrice || pos.price || 0);
      const currentSl = Number(pos.sl || 0);
      const currentTp = Number(pos.tp || 0);
      let newSl = 0;

      if (isBuy) {
        const be = openPrice + atr * 0.1;
        if (currentSl < be) newSl = be;
        else if (profit >= 1.5) {
          const trail = price - atr * 0.5;
          if (trail > currentSl) newSl = trail;
        }
      } else {
        const be = openPrice - atr * 0.1;
        if (!currentSl || currentSl > be) newSl = be;
        else if (profit >= 1.5) {
          const trail = price + atr * 0.5;
          if (trail < currentSl) newSl = trail;
        }
      }

      if (newSl > 0 && Math.abs(newSl - currentSl) > atr * 0.1) {
        queueCommand('MODIFY_SL', { ticket: pos.ticket, sl: newSl, tp: currentTp, symbol: accountState.eaSymbol });
      }
    });
  }

  // 2. Pyramiding / Add Trades Logic (KEEP)
  if (openCount >= maxOpen) return;

  // 3. SMC Signal Logic (OB + FVG + BOS/CHoCH)
  let signal = 'NONE';
  let zoneType = '';

  // Check multiple timeframes for SMC zones
  ['M5', 'M15', 'H1'].forEach(tf => {
    if (signal !== 'NONE' || !structures[tf]) return;
    
    const { orderBlocks, fvgs, trend } = structures[tf];
    
    // Check Order Blocks
    orderBlocks.forEach(ob => {
      if (ob.type === 'BULLISH' && price <= ob.top && price >= ob.bottom) {
        signal = 'BUY';
        zoneType = `${tf} BULL OB`;
      } else if (ob.type === 'BEARISH' && price >= ob.bottom && price <= ob.top) {
        signal = 'SELL';
        zoneType = `${tf} BEAR OB`;
      }
    });

    // Check FVGs
    fvgs.forEach(fvg => {
      if (fvg.type === 'BULLISH' && price <= fvg.top && price >= fvg.bottom) {
        signal = 'BUY';
        zoneType = `${tf} BULL FVG`;
      } else if (fvg.type === 'BEARISH' && price >= fvg.bottom && price <= fvg.top) {
        signal = 'SELL';
        zoneType = `${tf} BEAR FVG`;
      }
    });
  });

  if (signal === 'NONE') return;

  // 4. Candlestick Confirmation (KEEP)
  if (!confirmationsPass(signal, zoneType, price)) return;

  // 5. Execution
  const hasOpposite = positions.some((p) => String(p.type || '').toUpperCase() !== signal);
  if (hasOpposite) {
    queueCommand('CLOSE_ALL', { symbol: accountState.eaSymbol });
    botControl.pendingSignal = signal;
    botControl.lastActionAt = now;
    return;
  }

  // Allow adding more trades of the same type (Pyramiding)
  queueCommand(signal, { sl: 0, tp: 0, symbol: accountState.eaSymbol, lots: botControl.defaultLots });
  botControl.lastActionAt = now;
  botControl.lastSignal = signal;
}

setInterval(runBackendBrain, SIGNAL_SCAN_INTERVAL_MS);

// Account endpoint - returns current account state
app.get('/api/account', (req, res) => {
  // Check if EA has gone offline (no heartbeat for 60 seconds)
  if (accountState.ea_connected && (Date.now() - accountState.lastEaUpdate > 60000)) {
    console.log('[EA] ⚠️ EA detected as offline (heartbeat timeout)');
    accountState.ea_connected = false;
  }

  console.log(`[ACCOUNT] Data requested. EA Status: ${accountState.ea_connected ? 'ONLINE' : 'OFFLINE'}`);
  
  // Ensure equity is calculated correctly
  const totalProfit = accountState.positions.reduce((sum, pos) => {
    if (pos.profit && typeof pos.profit === 'number') {
      let profit = pos.profit;
      // Recalculate if profit seems unrealistic
      if (Math.abs(profit) > 1000) {
        const currentPrice = accountState.price || 4565.58;
        const priceDiff = pos.type === 'BUY' 
          ? currentPrice - pos.openPrice 
          : pos.openPrice - currentPrice;
        profit = priceDiff * pos.volume * 100;
      }
      return sum + profit;
    }
    return sum;
  }, 0);
  
  // Update equity with correct calculation
  const responseState = {
    ...accountState,
    profit: totalProfit,
    pnl_today: totalProfit,
    equity: accountState.balance + totalProfit,
    botControl,
    lastSeen: accountState.lastEaUpdate > 0 ? new Date(accountState.lastEaUpdate).toISOString() : accountState.lastSeen
  };
  
  res.json(responseState);
});

app.get('/api/subscription', (req, res) => {
  res.json({
    plan: 'PAID',
    status: 'Active',
    expiry: '2026-12-31',
    features: {
      maxTrades: 5,
      maxOpenTrades: 5,
      trailingStop: true,
      sessionFilter: true
    }
  });
});

app.post('/api/bot/config', (req, res) => {
  const { apiKey, autoTradingEnabled, executionMode, defaultLots, maxOpenTrades, trailingStopEnabled } = req.body || {};
  const effectiveApiKey = apiKey || req.headers['x-api-key'] || 'FXSK-DEFAULT-KEY-2025';
  if (!String(effectiveApiKey).startsWith('FXSK-')) {
    return res.status(401).json({ success: false, message: 'Invalid API key' });
  }

  if (typeof autoTradingEnabled === 'boolean') botControl.autoTradingEnabled = autoTradingEnabled;
  if (executionMode === 'app' || executionMode === 'backend') botControl.executionMode = executionMode;
  if (typeof defaultLots === 'number' && defaultLots > 0) botControl.defaultLots = defaultLots;
  if (typeof maxOpenTrades === 'number' && maxOpenTrades > 0) botControl.maxOpenTrades = Math.floor(maxOpenTrades);
  if (typeof trailingStopEnabled === 'boolean') botControl.trailingStopEnabled = trailingStopEnabled;

  // Hard anti-clash: when app mode is selected, backend pending signal is flushed.
  if (botControl.executionMode === 'app') {
    botControl.pendingSignal = null;
  }

  return res.json({ success: true, botControl });
});

// Trading mode toggle for app brain switch
app.patch('/api/trading/mode', (req, res) => {
  const { mode } = req.body || {};
  const normalized = String(mode || '').toUpperCase();
  if (normalized !== 'BACKEND' && normalized !== 'LOCAL') {
    return res.status(400).json({ success: false, message: 'mode must be BACKEND or LOCAL' });
  }

  if (normalized === 'BACKEND') {
    botControl.executionMode = 'backend';
    botControl.autoTradingEnabled = true;
  } else {
    botControl.executionMode = 'app';
    botControl.autoTradingEnabled = false;
    botControl.pendingSignal = null;
  }

  return res.json({
    success: true,
    tradingMode: normalized,
    isActive: botControl.executionMode === 'backend' && botControl.autoTradingEnabled,
    botControl
  });
});

app.get('/api/trading/mode', (req, res) => {
  const tradingMode = botControl.executionMode === 'backend' ? 'BACKEND' : 'LOCAL';
  return res.json({
    tradingMode,
    isActive: botControl.executionMode === 'backend' && botControl.autoTradingEnabled
  });
});

// Command queue for EA
let pendingCommands = [];

// Order management endpoints
app.post('/api/order', (req, res) => {
  const { action, symbol, type, lots, sl, tp, ticket, apiKey, top, bottom, zoneType, time, price, levelType } = req.body;
  
  console.log(`[ORDER] ${action || type} request for ${symbol} - Type: ${type} - Lots: ${lots}`);
  
  // Default API key if not provided
  const effectiveApiKey = apiKey || 'FXSK-DEFAULT-KEY-2025';
  if (!effectiveApiKey.startsWith('FXSK-')) {
    return res.status(401).json({
      success: false,
      message: 'Invalid API key'
    });
  }
  
  const normalizedAction = action || type;
  const commandString = buildCommandString(normalizedAction, { sl, tp, ticket, top, bottom, zoneType, time, price, levelType });
  if (!commandString) {
    console.log(`[ORDER] Unknown action: ${normalizedAction}`);
    return res.status(400).json({
      success: false,
      message: 'Unknown action'
    });
  }
  
  // Add command to pending queue for EA
  const command = {
    action: normalizedAction,
    command: commandString,
    symbol: symbol || 'BTCUSD',
    lots: lots || 0.1,
    sl: sl || 0,
    tp: tp || 0,
    ticket: ticket,
    top: top,
    bottom: bottom,
    zoneType: zoneType,
    time: time,
    price: price,
    levelType: levelType,
    createdAt: new Date().toISOString()
  };
  
  pendingCommands.push(command);
  
  console.log(`[ORDER] Command queued for EA: ${commandString}`);
  console.log(`[ORDER] Pending commands: ${pendingCommands.length}`);
  
  res.json({
    success: true,
    message: 'Command queued for EA execution',
    command: commandString,
    pendingCount: pendingCommands.length
  });
});

// Closed orders endpoint
app.get('/api/orders/closed', (req, res) => {
  const filter = String(req.query.filter || 'today').toLowerCase();
  const now = Date.now();
  const start =
    filter === 'week'
      ? now - 7 * 24 * 60 * 60 * 1000
      : filter === 'month'
      ? now - 30 * 24 * 60 * 60 * 1000
      : now - 24 * 60 * 60 * 1000;

  const filtered = closedTrades.filter((t) => {
    const ts = new Date(t.closeTime || t.date || 0).getTime();
    return Number.isFinite(ts) && ts >= start;
  });

  res.json(filtered.map((t) => normalizeClosedTrade(t)));
});

// MT5 bridge callback: execution result
// TODO: Confirm this path and payload keys match your .mph/.mqh file exactly.
app.post('/api/ea/trade-executed', (req, res) => {
  const { apiKey, trade } = req.body || {};
  const effectiveApiKey = apiKey || req.headers['x-api-key'] || process.env.MT5_BRIDGE_API_KEY;
  if (process.env.MT5_BRIDGE_API_KEY && effectiveApiKey !== process.env.MT5_BRIDGE_API_KEY) {
    return res.status(401).json({ success: false, message: 'Invalid MT5 bridge API key' });
  }

  if (trade && typeof trade === 'object') {
    closedTrades.unshift(normalizeClosedTrade({
      id: `${trade.ticket || 'unknown'}-${Date.now()}`,
      ticket: trade.ticket,
      symbol: trade.symbol || accountState.eaSymbol || 'BTCUSD',
      type: trade.type || 'BUY',
      profit: trade.profit,
      lots: trade.lots || trade.volume,
      openPrice: trade.openPrice || trade.priceOpen || trade.entryPrice,
      closePrice: trade.closePrice || trade.priceClose || trade.exitPrice || accountState.price,
      sl: trade.sl || trade.stopLoss,
      tp: trade.tp || trade.takeProfit,
      closeReason: trade.closeReason,
      openTime: trade.openTime || new Date().toISOString(),
      closeTime: trade.closeTime || new Date().toISOString(),
      date: trade.closeTime || new Date().toISOString(),
    }));
    if (closedTrades.length > 500) closedTrades = closedTrades.slice(0, 500);
    saveClosedTradesToDisk();
  }

  return res.json({ success: true });
});

// MT5 bridge callback: historical sync
// TODO: Confirm this path and payload shape match your .mph/.mqh file exactly.
app.post('/api/ea/sync-history', (req, res) => {
  const { apiKey, trades } = req.body || {};
  const effectiveApiKey = apiKey || req.headers['x-api-key'] || process.env.MT5_BRIDGE_API_KEY;
  if (process.env.MT5_BRIDGE_API_KEY && effectiveApiKey !== process.env.MT5_BRIDGE_API_KEY) {
    return res.status(401).json({ success: false, message: 'Invalid MT5 bridge API key' });
  }

  if (Array.isArray(trades)) {
    const mapped = trades.map((t) =>
      normalizeClosedTrade({
        id: `${t.ticket || 'unknown'}-${Date.now()}-${Math.random()}`,
        ticket: t.ticket,
        symbol: t.symbol || accountState.eaSymbol || 'BTCUSD',
        type: t.type || 'BUY',
        profit: t.profit,
        lots: t.lots || t.volume,
        openPrice: t.openPrice || t.priceOpen || t.entryPrice,
        closePrice: t.closePrice || t.priceClose || t.exitPrice,
        sl: t.sl || t.stopLoss,
        tp: t.tp || t.takeProfit,
        closeReason: t.closeReason,
        openTime: t.openTime || new Date().toISOString(),
        closeTime: t.closeTime || new Date().toISOString(),
        date: t.closeTime || new Date().toISOString(),
      })
    );
    closedTrades = [...mapped, ...closedTrades].slice(0, 500);
    saveClosedTradesToDisk();
  }

  return res.json({ success: true });
});

app.get('/api/signal', (req, res) => {
  const { symbol = 'BTCUSD', tf = 'M5' } = req.query;
  const currentPrice = Number(accountState.price || 0);
  const spread = Number(accountState.spread || 0);
  const structures = accountState.structures || {};
  const timeframe = String(tf).toUpperCase();
  const tfStructures = structures[timeframe] || {};
  const orderBlocks = tfStructures.orderBlocks || [];
  const fvgs = tfStructures.fvgs || [];

  if (!accountState.ea_connected) {
    return res.json({
      symbol,
      tf: timeframe,
      signal: 'HOLD',
      confidence: 0,
      reason: 'EA not connected'
    });
  }

  if (spread > 35) {
    return res.json({
      symbol,
      tf: timeframe,
      signal: 'HOLD',
      confidence: 15,
      reason: `High spread: ${spread}`
    });
  }

  let signal = 'HOLD';
  let confidence = 0;
  let reason = 'Searching for SMC setup...';

  // Check for Order Block entry
  const ob = orderBlocks.find(o => currentPrice <= o.top && currentPrice >= o.bottom);
  if (ob) {
    signal = ob.type === 'BULLISH' ? 'BUY' : 'SELL';
    confidence = 75;
    reason = `SMC: Price inside ${tf} ${ob.type} Order Block`;
  }

  // Check for FVG entry
  if (signal === 'HOLD') {
    const fvg = fvgs.find(f => currentPrice <= f.top && currentPrice >= f.bottom);
    if (fvg) {
      signal = fvg.type === 'BULLISH' ? 'BUY' : 'SELL';
      confidence = 70;
      reason = `SMC: Price inside ${tf} ${fvg.type} FVG`;
    }
  }

  // Candlestick Confirmation
  if (signal !== 'HOLD') {
    if (confirmationsPass(signal, reason, currentPrice)) {
      confidence += 20;
      reason += ' + Candlestick confirmation';
    } else {
      confidence -= 30;
      reason += ' (Waiting for candlestick confirmation)';
    }
  }

  res.json({
    symbol,
    tf: timeframe,
    signal,
    confidence,
    reason
  });
});

// Start server
loadClosedTradesFromDisk();
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Initial Account State: Balance: R${accountState.balance}, Equity: R${accountState.equity}, Positions: ${accountState.positions.length}`);
});
