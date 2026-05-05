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
  structures: {},
  keyLevelInfo: null,
};

app.use(cors());
app.use(bodyParser.json());

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
  
  const { accountData, testStructures, structures } = req.body;
  
  // Update account state with real EA data
  if (accountData) {
    const prevBalance = accountState.balance;
    const prevEquity = accountState.equity;
    const prevPrice = accountState.price;
    
    accountState.balance = accountData.balance || accountState.balance;
    accountState.equity = accountData.equity || accountState.balance;
    accountState.price = accountData.price || accountState.price;
    accountState.positions = accountData.positions || accountState.positions;
    accountState.ea_connected = true;
    accountState.eaSymbol = accountData.symbol || accountState.eaSymbol || 'BTCUSD';
    accountState.fastEMA = accountData.fastEMA || 0;
    accountState.slowEMA = accountData.slowEMA || 0;
    accountState.bbUpper = accountData.bbUpper || 0;
    accountState.bbLower = accountData.bbLower || 0;
    accountState.rsi = accountData.rsi || 0;
    accountState.atr = accountData.atr || 0;
    accountState.vwap = accountData.vwap || 0;
    accountState.spread = accountData.spread || 0;
    accountState.tickVolume = accountData.tickVolume || 0;
    
    // Enhanced logging
    console.log(` [Backend] Market Data - Price: ${accountState.price} | EMA: ${accountState.fastEMA}/${accountState.slowEMA} | RSI: ${accountState.rsi}`);
    console.log(` [Backend] Account - Balance: R${accountState.balance} | Equity: R${accountState.equity} | Positions: ${accountState.positions.length}`);
    
    // Store structures from EA (supports both payload keys)
    const incomingStructures = structures || testStructures;
    if (incomingStructures && typeof incomingStructures === 'object') {
      accountState.structures = incomingStructures;
      console.log(` [Backend] Structures updated - Timeframes: ${Object.keys(incomingStructures).join(', ')}`);
      
      // Calculate key level distances
      const keyLevelInfo = calculateKeyLevelDistance(accountState.price, incomingStructures);
      if (keyLevelInfo) {
        console.log(` [Backend] Next Key Level - ${keyLevelInfo.type} at ${keyLevelInfo.level} (${keyLevelInfo.distance}pts away)`);
        accountState.keyLevelInfo = keyLevelInfo;
      } else {
        accountState.keyLevelInfo = null;
      }
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
      console.log(` [Backend] Balance changed: R${prevBalance} → R${accountState.balance}`);
    }
    if (Math.abs(prevEquity - accountState.equity) > 0.01) {
      console.log(` [Backend] Equity changed: R${prevEquity} → R${accountState.equity}`);
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
  
  res.json({
    ea_connected: true,
    lastSeen: new Date().toISOString(),
    structures: accountState.structures,
    keyLevelInfo: accountState.keyLevelInfo,
    commands: commandsToSend.map(cmd => cmd.command) // Send only command strings to EA
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
    equity: accountState.balance + totalProfit
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
  
  // Build command string for EA based on action type
  let commandString = '';
  
  switch (action || type) {
    case 'BUY':
      commandString = `BUY|${sl || 0}|${tp || 0}`;
      break;
      
    case 'SELL':
      commandString = `SELL|${sl || 0}|${tp || 0}`;
      break;
      
    case 'CLOSE_TRADE':
      commandString = `CLOSE_TICKET_${ticket}`;
      break;
      
    case 'CLOSE_ALL':
      commandString = `CLOSE_ALL`;
      break;
      
    case 'DRAW_OB':
      commandString = `DRAW_OB|${top}|${bottom}|${zoneType || 'BULLISH'}|${time || 0}`;
      break;
      
    case 'DRAW_FVG':
      commandString = `DRAW_FVG|${top}|${bottom}|${zoneType || 'BULLISH'}|${time || 0}`;
      break;
      
    case 'DRAW_KEY_LEVEL':
      commandString = `DRAW_KEY_LEVEL|${price}|${levelType || 'support'}`;
      break;
      
    case 'RESUME':
      commandString = 'RESUME';
      break;
      
    case 'PAUSE':
      commandString = 'PAUSE';
      break;
      
    default:
      console.log(`[ORDER] Unknown action: ${action || type}`);
      return res.status(400).json({
        success: false,
        message: 'Unknown action'
      });
  }
  
  // Add command to pending queue for EA
  const command = {
    action: action || type,
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
  res.json([]);
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
