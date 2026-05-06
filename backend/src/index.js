const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 5000;

// In-memory account state - starts empty, populated by EA
let accountState = {
  balance: 200000,
  equity: 200000,
  positions: [],
  lastSeen: new Date().toISOString(),
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
let botControl = {
  autoTradingEnabled: false,
  executionMode: 'app', // 'app' | 'backend'
  defaultLots: 0.01,
  maxOpenTrades: 5,
  trailingStopEnabled: true,
  lastActionAt: 0,
  lastSignal: 'NONE',
  pendingSignal: null
};

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
  console.log('[EA] License validation request:', apiKey);
  
  // Simple validation - accept any key starting with FXSK-
  if (apiKey && apiKey.startsWith('FXSK-')) {
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
  console.log(' [Backend] EA heartbeat received');
  
  const { accountData, testStructures, structures, positions, chart, logs: eaLogs } = req.body;
  
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
        const profit = Number(p.profit || 0);
        closedTrades.unshift({
          id: `${ticket}-${Date.now()}`,
          ticket,
          symbol: p.symbol || accountState.eaSymbol || 'BTCUSD',
          type: p.type || 'BUY',
          profit,
          openTime: openTimeIso,
          closeTime: closeTimeIso,
          date: closeTimeIso
        });
      }
    });
    if (closedTrades.length > 500) closedTrades = closedTrades.slice(0, 500);
    
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
    
    // Calculate key level distances
    const keyLevelInfo = calculateKeyLevelDistance(accountState.price, accountState.structures);
    if (keyLevelInfo) {
      console.log(` [Backend] Next Key Level - ${keyLevelInfo.type} at ${keyLevelInfo.level} (${keyLevelInfo.distance.toFixed(2)}pts away)`);
      accountState.keyLevelInfo = keyLevelInfo;
    } else {
      accountState.keyLevelInfo = null;
    }

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

function normalizeStructuresForSignal(rawStructures, currentPrice) {
  const base = (rawStructures && typeof rawStructures === 'object') ? rawStructures : {};
  const tfList = ['M5', 'M15', 'H1', 'H4'];
  const out = {};

  tfList.forEach((tf) => {
    const tfData = (base[tf] && typeof base[tf] === 'object') ? base[tf] : {};
    out[tf] = {
      keyLevels: Array.isArray(tfData.keyLevels) ? tfData.keyLevels : [],
      orderBlocks: Array.isArray(tfData.orderBlocks) ? tfData.orderBlocks : [],
      fvgs: Array.isArray(tfData.fvgs) ? tfData.fvgs : []
    };
  });

  const totalLevels = tfList.reduce((sum, tf) => sum + out[tf].keyLevels.length, 0);
  if (totalLevels === 0 && currentPrice > 0) {
    out.M5.keyLevels.push({
      type: 'SUPPORT',
      price: Number((currentPrice - 20).toFixed(2)),
      strength: 1
    });
    out.M5.keyLevels.push({
      type: 'RESISTANCE',
      price: Number((currentPrice + 20).toFixed(2)),
      strength: 1
    });
  }

  return out;
}

function generateBasicStructures(charts) {
  const structures = {};
  const tfs = Object.keys(charts);
  
  tfs.forEach(tf => {
    const candles = charts[tf];
    if (!Array.isArray(candles) || candles.length < 10) return;
    
    const keyLevels = [];
    const sorted = [...candles].sort((a, b) => b.x - a.x); // Newest first
    
    // Simple Peak/Trough detection for Key Levels
    for (let i = 2; i < Math.min(sorted.length - 2, 50); i++) {
      // Resistance (Peak)
      if (sorted[i].high > sorted[i-1].high && sorted[i].high > sorted[i-2].high &&
          sorted[i].high > sorted[i+1].high && sorted[i].high > sorted[i+2].high) {
        keyLevels.push({ price: sorted[i].high, type: 'RESISTANCE', strength: 1 });
      }
      // Support (Trough)
      if (sorted[i].low < sorted[i-1].low && sorted[i].low < sorted[i-2].low &&
          sorted[i].low < sorted[i+1].low && sorted[i].low < sorted[i+2].low) {
        keyLevels.push({ price: sorted[i].low, type: 'SUPPORT', strength: 1 });
      }
    }
    
    structures[tf] = {
      keyLevels: keyLevels.slice(0, 5), // Keep top 5 per TF
      orderBlocks: [],
      fvgs: []
    };
  });
  
  return structures;
}

// Helper function to calculate key level distances
function calculateKeyLevelDistance(currentPrice, structures) {
  if (!structures || !currentPrice) return null;
  
  let nearestLevel = null;
  let minDistance = Infinity;
  let nearestType = '';
  
  // Check all timeframes for key levels
  ['M5', 'M15', 'H1', 'H4'].forEach(timeframe => {
    if (structures[timeframe]) {
      const tfStructures = structures[timeframe];
      
      // Check key levels
      if (tfStructures.keyLevels) {
        tfStructures.keyLevels.forEach(level => {
          const distance = Math.abs(currentPrice - level.price);
          if (distance < minDistance) {
            minDistance = distance;
            nearestLevel = level.price;
            nearestType = `${timeframe} ${level.type}`;
          }
        });
      }
      
      // Check order blocks
      if (tfStructures.orderBlocks) {
        tfStructures.orderBlocks.forEach(ob => {
          const distance = Math.abs(currentPrice - ob.top);
          if (distance < minDistance) {
            minDistance = distance;
            nearestLevel = ob.top;
            nearestType = `${timeframe} OB Top`;
          }
          
          const bottomDistance = Math.abs(currentPrice - ob.bottom);
          if (bottomDistance < minDistance) {
            minDistance = bottomDistance;
            nearestLevel = ob.bottom;
            nearestType = `${timeframe} OB Bottom`;
          }
        });
      }
    }
  });
  
  if (nearestLevel !== null) {
    return {
      level: nearestLevel,
      distance: minDistance,
      type: nearestType
    };
  }
  
  return null;
}

function runBackendBrain() {
  if (!accountState.ea_connected) return;
  if (!botControl.autoTradingEnabled) return;
  if (botControl.executionMode !== 'backend') return;

  const now = Date.now();
  if (now - botControl.lastActionAt < 3000) return;

  const positions = Array.isArray(accountState.positions) ? accountState.positions : [];
  const openCount = positions.length;
  const maxOpen = Math.max(1, Number(botControl.maxOpenTrades || 1));
  const price = Number(accountState.price || 0);
  const atr = Math.max(Number(accountState.atr || 0), 0.01);
  const spread = Number(accountState.spread || 0);
  const rsi = Number(accountState.rsi || 50);
  const fastEMA = Number(accountState.fastEMA || 0);
  const slowEMA = Number(accountState.slowEMA || 0);
  const kl = accountState.keyLevelInfo;

  if (spread > 35 || !price) return;

  // Trailing runs only in backend mode and only if enabled.
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

  // Execute pending signal after CLOSE_ALL has had a cycle to process.
  if (botControl.pendingSignal && openCount === 0) {
    const side = botControl.pendingSignal;
    queueCommand(side, { sl: 0, tp: 0, symbol: accountState.eaSymbol, lots: botControl.defaultLots });
    botControl.lastActionAt = now;
    botControl.lastSignal = side;
    botControl.pendingSignal = null;
    return;
  }

  if (!kl || openCount >= maxOpen) return;

  const klType = String(kl.type || '').toUpperCase();
  const bullBias = fastEMA >= slowEMA;
  const bearBias = fastEMA <= slowEMA;
  let signal = 'NONE';

  if (klType.includes('SUPPORT') && rsi <= 50 && bullBias) signal = 'BUY';
  if (klType.includes('RESISTANCE') && rsi >= 50 && bearBias) signal = 'SELL';
  if (signal === 'NONE') return;

  const hasOpposite = positions.some((p) => String(p.type || '').toUpperCase() !== signal);
  if (hasOpposite) {
    queueCommand('CLOSE_ALL', { symbol: accountState.eaSymbol });
    botControl.pendingSignal = signal;
    botControl.lastActionAt = now;
    return;
  }

  const hasSameSide = positions.some((p) => String(p.type || '').toUpperCase() === signal);
  if (hasSameSide) return;

  queueCommand(signal, { sl: 0, tp: 0, symbol: accountState.eaSymbol, lots: botControl.defaultLots });
  botControl.lastActionAt = now;
  botControl.lastSignal = signal;
}

setInterval(runBackendBrain, 2000);

// Account endpoint - returns current account state
app.get('/api/account', (req, res) => {
  console.log('[ACCOUNT] Account data requested');
  accountState.lastSeen = new Date().toISOString();
  
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
    botControl
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

  res.json(filtered);
});

app.get('/api/signal', (req, res) => {
  const { symbol = 'BTCUSD', tf = 'M5' } = req.query;
  const currentPrice = Number(accountState.price || 0);
  const fastEMA = Number(accountState.fastEMA || 0);
  const slowEMA = Number(accountState.slowEMA || 0);
  const rsi = Number(accountState.rsi || 0);
  const spread = Number(accountState.spread || 0);
  const atr = Number(accountState.atr || 0);
  const structures = normalizeStructuresForSignal(accountState.structures, currentPrice);
  const timeframe = String(tf).toUpperCase();
  const tfStructures = structures[timeframe] || structures.M5;
  const keyLevels = tfStructures.keyLevels || [];
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

  if (spread > 35 || atr > 6.0) {
    return res.json({
      symbol,
      tf: timeframe,
      signal: 'HOLD',
      confidence: 15,
      reason: `Risk filter active (spread=${spread}, atr=${atr})`
    });
  }

  const nearestKeyLevel = keyLevels.reduce((best, level) => {
    const dist = Math.abs(currentPrice - Number(level.price || 0));
    if (!best || dist < best.dist) return { level, dist };
    return best;
  }, null);

  const hasBullOB = orderBlocks.some((ob) => String(ob.type || '').toUpperCase().includes('BULL'));
  const hasBearOB = orderBlocks.some((ob) => String(ob.type || '').toUpperCase().includes('BEAR'));
  const hasBullFVG = fvgs.some((g) => String(g.type || '').toUpperCase().includes('BULL'));
  const hasBearFVG = fvgs.some((g) => String(g.type || '').toUpperCase().includes('BEAR'));

  const emaBull = fastEMA > 0 && slowEMA > 0 && fastEMA > slowEMA;
  const emaBear = fastEMA > 0 && slowEMA > 0 && fastEMA < slowEMA;
  const nearLevel = nearestKeyLevel && nearestKeyLevel.dist <= Math.max(currentPrice * 0.002, 8);
  const levelType = nearestKeyLevel ? String(nearestKeyLevel.level.type || '').toUpperCase() : '';

  let signal = 'HOLD';
  let confidence = 30;
  let reason = 'No clean confluence yet';

  if (emaBull && rsi <= 65 && (hasBullOB || hasBullFVG) && nearLevel && levelType.includes('SUPPORT')) {
    signal = 'BUY';
    confidence = 78;
    reason = 'SMC bullish confluence at support + EMA confirmation';
  } else if (emaBear && rsi >= 35 && (hasBearOB || hasBearFVG) && nearLevel && levelType.includes('RESISTANCE')) {
    signal = 'SELL';
    confidence = 78;
    reason = 'SMC bearish confluence at resistance + EMA confirmation';
  } else if (emaBull && rsi < 70) {
    signal = 'BUY';
    confidence = 55;
    reason = 'Trend-following fallback: EMA bullish with acceptable RSI';
  } else if (emaBear && rsi > 30) {
    signal = 'SELL';
    confidence = 55;
    reason = 'Trend-following fallback: EMA bearish with acceptable RSI';
  }

  res.json({
    symbol,
    tf: timeframe,
    signal,
    confidence,
    reason,
    price: currentPrice,
    indicators: {
      fastEMA,
      slowEMA,
      rsi,
      atr,
      spread
    },
    structures: {
      keyLevels: keyLevels.length,
      orderBlocks: orderBlocks.length,
      fvgs: fvgs.length
    }
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Initial Account State: Balance: R${accountState.balance}, Equity: R${accountState.equity}, Positions: ${accountState.positions.length}`);
});
