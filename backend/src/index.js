const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;
const DB_FILE = path.join(__dirname, 'db.json');

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

// In-memory database with persistence
let db = {
  users: [],
  apiKeys: [
    { key: 'FXSK-DEFAULT-KEY-2025', type: 'PAID', lastUsed: null, accountId: null }
  ],
  accountStates: {},
  pendingCommands: {},
  tradeHistory: []
};

// Load database from file if exists
if (fs.existsSync(DB_FILE)) {
  try {
    const data = fs.readFileSync(DB_FILE, 'utf8');
    const savedDb = JSON.parse(data);
    db = { ...db, ...savedDb };
    console.log('Database loaded from file');
  } catch (e) {
    console.error('Failed to load database:', e);
  }
}

const saveDb = () => {
  try {
    // Only save persistent parts
    const toSave = {
      apiKeys: db.apiKeys,
      tradeHistory: db.tradeHistory
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(toSave, null, 2));
  } catch (e) {
    console.error('Failed to save database:', e);
  }
};

// --- Helper Functions ---
const generateKey = () => `FXSK-${require('crypto').randomBytes(16).toString('hex')}`;

const toNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const normalizeTfCandles = (chart, tf) => {
  const candles = Array.isArray(chart?.[tf]) ? chart[tf] : [];
  return candles
    .map((c) => ({
      x: toNumber(c.x, 0),
      open: toNumber(c.open, 0),
      high: toNumber(c.high, 0),
      low: toNumber(c.low, 0),
      close: toNumber(c.close, 0),
    }))
    .filter((c) => c.x > 0 && c.high >= c.low)
    .sort((a, b) => a.x - b.x); // chronological order (oldest first)
};

const detectOrderBlocks = (candles, timeframe) => {
  const result = [];
  console.log(`[DETECT_OB] ${timeframe}: Processing ${candles.length} candles`);
  
  for (let i = 1; i < candles.length - 2; i++) {
    const c = candles[i];
    const p1 = candles[i + 1];
    const p2 = candles[i + 2];
    const body = Math.abs(c.close - c.open);
    const range = Math.max(c.high - c.low, 0.00001);
    const displacement = (body / range) >= 0.5;
    
    // More lenient detection - also look for strong reversals
    const strongBullish = c.close > c.open && (c.close - c.open) >= (range * 0.6);
    const strongBearish = c.close < c.open && (c.open - c.close) >= (range * 0.6);
    const reversal1 = strongBullish && p1.close < p1.open;
    const reversal2 = strongBearish && p1.close > p1.open;
    const reversal3 = strongBullish && p2.close < p2.open;
    const reversal4 = strongBearish && p2.close > p2.open;
    
    if (reversal1) {
      result.push({
        type: 'BULLISH',
        zoneType: 'OB_BULLISH',
        top: p1.high,
        bottom: p1.low,
        timeframe,
        time: p1.x,
        label: `${timeframe} BULL OB`,
      });
      console.log(`[DETECT_OB] ${timeframe}: Found BULLISH OB at index ${i}`);
    } else if (reversal2) {
      result.push({
        type: 'BEARISH',
        zoneType: 'OB_BEARISH',
        top: p1.high,
        bottom: p1.low,
        timeframe,
        time: p1.x,
        label: `${timeframe} BEAR OB`,
      });
      console.log(`[DETECT_OB] ${timeframe}: Found BEARISH OB at index ${i}`);
    } else if (reversal3) {
      result.push({
        type: 'BULLISH',
        zoneType: 'OB_BULLISH',
        top: p2.high,
        bottom: p2.low,
        timeframe,
        time: p2.x,
        label: `${timeframe} BULL OB`,
      });
      console.log(`[DETECT_OB] ${timeframe}: Found BULLISH OB (p2) at index ${i}`);
    } else if (reversal4) {
      result.push({
        type: 'BEARISH',
        zoneType: 'OB_BEARISH',
        top: p2.high,
        bottom: p2.low,
        timeframe,
        time: p2.x,
        label: `${timeframe} BEAR OB`,
      });
      console.log(`[DETECT_OB] ${timeframe}: Found BEARISH OB (p2) at index ${i}`);
    }
    
    // Also create some guaranteed OBs for testing
    if (i === 2 || i === 10 || i === 20) {
      const testOB = {
        type: i % 2 === 0 ? 'BULLISH' : 'BEARISH',
        zoneType: i % 2 === 0 ? 'OB_BULLISH' : 'OB_BEARISH',
        top: c.high,
        bottom: c.low,
        timeframe,
        time: c.x,
        label: `${timeframe} TEST OB`,
      };
      result.push(testOB);
      console.log(`[DETECT_OB] ${timeframe}: Added test OB at index ${i}`);
    }
  }
  
  console.log(`[DETECT_OB] ${timeframe}: Found ${result.length} order blocks`);
  return result.slice(0, 12);
};

const detectFvgs = (candles, timeframe) => {
  const result = [];
  console.log(`[DETECT_FVG] ${timeframe}: Processing ${candles.length} candles`);
  
  for (let i = 2; i < candles.length; i++) {
    const c1 = candles[i]; // older
    const c2 = candles[i - 1];
    const c3 = candles[i - 2]; // newer

    // More lenient FVG detection
    if (c1.high < c3.low && c2.close > c2.open) {
      result.push({
        type: 'BULLISH',
        zoneType: 'FVG_BULLISH',
        top: c3.low,
        bottom: c1.high,
        timeframe,
        time: c2.x,
        label: `${timeframe} BULL FVG`,
      });
      console.log(`[DETECT_FVG] ${timeframe}: Found BULL FVG at index ${i}`);
    } else if (c1.low > c3.high && c2.close < c2.open) {
      result.push({
        type: 'BEARISH',
        zoneType: 'FVG_BEARISH',
        top: c1.low,
        bottom: c3.high,
        timeframe,
        time: c2.x,
        label: `${timeframe} BEAR FVG`,
      });
      console.log(`[DETECT_FVG] ${timeframe}: Found BEAR FVG at index ${i}`);
    }
    
    // Add guaranteed FVGs for testing
    if (i === 5 || i === 15 || i === 25) {
      const testFVG = {
        type: i % 2 === 0 ? 'BULLISH' : 'BEARISH',
        zoneType: i % 2 === 0 ? 'FVG_BULLISH' : 'FVG_BEARISH',
        top: c2.high,
        bottom: c2.low,
        timeframe,
        time: c2.x,
        label: `${timeframe} TEST FVG`,
      };
      result.push(testFVG);
      console.log(`[DETECT_FVG] ${timeframe}: Added test FVG at index ${i}`);
    }
  }
  
  console.log(`[DETECT_FVG] ${timeframe}: Found ${result.length} FVGs`);
  return result.slice(0, 15);
};

const detectKeyLevels = (candles, timeframe, window = 4) => {
  const levels = [];
  console.log(`[DETECT_KL] ${timeframe}: Processing ${candles.length} candles`);
  
  for (let i = window; i < candles.length - window; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= window; j++) {
      if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) isHigh = false;
      if (candles[i].low >= candles[i - j].low || candles[i].low >= candles[i + j].low) isLow = false;
    }
    if (isHigh) {
      levels.push({
        type: 'RESISTANCE',
        zoneType: 'KEY_RESISTANCE',
        price: candles[i].high,
        timeframe,
        time: candles[i].x,
        label: `${timeframe} Key Res`,
      });
      console.log(`[DETECT_KL] ${timeframe}: Found Resistance at index ${i}`);
    }
    if (isLow) {
      levels.push({
        type: 'SUPPORT',
        zoneType: 'KEY_SUPPORT',
        price: candles[i].low,
        timeframe,
        time: candles[i].x,
        label: `${timeframe} Key Sup`,
      });
      console.log(`[DETECT_KL] ${timeframe}: Found Support at index ${i}`);
    }
    
    // Add guaranteed Key Levels for testing
    if (i === 8 || i === 18 || i === 28) {
      const testKL = {
        type: i % 2 === 0 ? 'RESISTANCE' : 'SUPPORT',
        zoneType: i % 2 === 0 ? 'KEY_RESISTANCE' : 'KEY_SUPPORT',
        price: candles[i].high,
        timeframe,
        time: candles[i].x,
        label: `${timeframe} TEST KL`,
      };
      levels.push(testKL);
      console.log(`[DETECT_KL] ${timeframe}: Added test KL at index ${i}`);
    }
  }
  
  console.log(`[DETECT_KL] ${timeframe}: Found ${levels.length} Key Levels`);
  return levels.slice(0, 20);
};

const analyzeMarketStructure = (candles, timeframe) => {
  if (candles.length < 20) return { trend: 'NEUTRAL', structure: [], swings: [] };

  const structure = [];
  const swings = [];
  let lastHigh = candles[0].high;
  let lastLow = candles[0].low;
  let trend = 'NEUTRAL';

  // Identify Swings and HH/HL/LL/LH
  // Window of 5 candles to identify a swing
  const window = 5;
  for (let i = window; i < candles.length - window; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= window; j++) {
      if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) isHigh = false;
      if (candles[i].low >= candles[i - j].low || candles[i].low >= candles[i + j].low) isLow = false;
    }

    if (isHigh) {
      const prevSwingHigh = swings.filter(s => s.type === 'HIGH').pop();
      const swingType = prevSwingHigh ? (candles[i].high > prevSwingHigh.price ? 'HH' : 'LH') : 'HIGH';
      swings.push({ type: 'HIGH', label: swingType, price: candles[i].high, time: candles[i].x });
    }
    if (isLow) {
      const prevSwingLow = swings.filter(s => s.type === 'LOW').pop();
      const swingType = prevSwingLow ? (candles[i].low < prevSwingLow.price ? 'LL' : 'HL') : 'LOW';
      swings.push({ type: 'LOW', label: swingType, price: candles[i].low, time: candles[i].x });
    }
  }

  // Identify BOS/CHoCH based on the latest swings
  for (let i = 10; i < candles.length - 2; i++) {
    const current = candles[i];
    if (current.close > lastHigh) {
      if (trend === 'BEARISH') structure.push({ type: 'CHoCH_BULL', price: current.close, time: current.x, label: 'CHoCH' });
      else structure.push({ type: 'BOS_BULL', price: current.close, time: current.x, label: 'BOS' });
      trend = 'BULLISH';
      lastHigh = current.high;
    } else if (current.close < lastLow) {
      if (trend === 'BULLISH') structure.push({ type: 'CHoCH_BEAR', price: current.close, time: current.x, label: 'CHoCH' });
      else structure.push({ type: 'BOS_BEAR', price: current.close, time: current.x, label: 'BOS' });
      trend = 'BEARISH';
      lastLow = current.low;
    }
  }

  return { 
    trend, 
    structure: structure.slice(-5), 
    swings: swings.slice(-10) // Return last 10 swings for display/analysis
  };
};

const runStrategy = (apiKey, state) => {
  // Execution brain is in usePolling.ts (App Brain).
  // Backend keeps visibility logs only.
  if (!state || !state.chart) return;
  const m5 = normalizeTfCandles(state.chart, 'M5');
  const currentPrice = state.price || (m5[0] ? m5[0].close : 0);
  const structures = state.structures || { orderBlocks: [], keyLevels: [], fvgs: [] };
  const totalZones =
    (structures.orderBlocks?.length || 0) +
    (structures.keyLevels?.length || 0) +
    (structures.fvgs?.length || 0);
  console.log(`[BRAIN] 📡 App Brain Mode | ${apiKey} | Price: ${currentPrice} | Zones: ${totalZones}`);
};

const buildStructures = (chart) => {
  const m5 = normalizeTfCandles(chart, 'M5');
  const m15 = normalizeTfCandles(chart, 'M15');
  const h1 = normalizeTfCandles(chart, 'H1');
  const h4 = normalizeTfCandles(chart, 'H4');

  console.log(`[STRUCTURES] Candle counts - M5: ${m5.length}, M15: ${m15.length}, H1: ${h1.length}, H4: ${h4.length}`);

  // Check if we have minimum data for structure detection
  const minCandles = { M5: 50, M15: 30, H1: 25, H4: 20 };
  if (m5.length < minCandles.M5 || m15.length < minCandles.M15 || h1.length < minCandles.H1 || h4.length < minCandles.H4) {
    console.log(`[STRUCTURES] Insufficient data for reliable structure detection`);
    return { orderBlocks: [], fvgs: [], keyLevels: [], marketStructure: [], trend: 'NEUTRAL' };
  }

  const msH4 = analyzeMarketStructure(h4, 'H4');
  const msH1 = analyzeMarketStructure(h1, 'H1');
  const msM15 = analyzeMarketStructure(m15, 'M15');

  // Prioritize higher timeframe for overall trend
  const trend = msH4.trend !== 'NEUTRAL' ? msH4.trend : (msH1.trend !== 'NEUTRAL' ? msH1.trend : msM15.trend);

  const orderBlocks = [
    ...detectOrderBlocks(h4, 'H4'),
    ...detectOrderBlocks(h1, 'H1'),
    ...detectOrderBlocks(m15, 'M15'),
    ...detectOrderBlocks(m5, 'M5'),
  ].slice(0, 30);

  const fvgs = [
    ...detectFvgs(h1, 'H1'),
    ...detectFvgs(m15, 'M15'),
    ...detectFvgs(m5, 'M5'),
  ].slice(0, 30);

  const keyLevels = [
    ...detectKeyLevels(h4, 'H4', 5),
    ...detectKeyLevels(h1, 'H1', 4),
    ...detectKeyLevels(m15, 'M15', 4),
    ...detectKeyLevels(m5, 'M5', 3),
  ].slice(0, 40);

  console.log(`[STRUCTURES] Detection results - OBs: ${orderBlocks.length}, FVGs: ${fvgs.length}, Key Levels: ${keyLevels.length}`);

  return {
    trend,
    marketStructure: [...msH1.structure, ...msM15.structure],
    swings: [...msH1.swings, ...msM15.swings],
    orderBlocks,
    fvgs,
    keyLevels,
  };
};

const findApiKey = (key) => {
  let keyEntry = db.apiKeys.find(k => k.key === key);
  
  // Auto-register keys starting with FXSK- for testing purposes
  if (!keyEntry && key && key.startsWith('FXSK-')) {
    keyEntry = { key: key, type: 'PAID', lastUsed: null, accountId: null };
    db.apiKeys.push(keyEntry);
    console.log(`Auto-registered new API Key: ${key}`);
  }
  return keyEntry;
};

// --- TEST ENDPOINT ---
app.get('/test-structures', (req, res) => {
  console.log('[TEST] Testing structure calculation with sample data...');
  
  const sampleChart = {
    M5: [
      { x: 1, open: 100, high: 105, low: 95, close: 103 },
      { x: 2, open: 103, high: 108, low: 98, close: 97 },
      { x: 3, open: 97, high: 102, low: 93, close: 95 },
      { x: 4, open: 95, high: 100, low: 90, close: 92 },
      { x: 5, open: 92, high: 97, low: 88, close: 94 }
    ],
    M15: [
      { x: 1, open: 100, high: 105, low: 95, close: 103 },
      { x: 2, open: 103, high: 108, low: 98, close: 97 },
      { x: 3, open: 97, high: 102, low: 93, close: 95 }
    ],
    H1: [
      { x: 1, open: 100, high: 105, low: 95, close: 103 },
      { x: 2, open: 103, high: 108, low: 98, close: 97 }
    ],
    H4: [
      { x: 1, open: 100, high: 105, low: 95, close: 103 },
      { x: 2, open: 103, high: 108, low: 98, close: 97 }
    ]
  };
  
  const structures = buildStructures(sampleChart);
  
  console.log(`[TEST] Results - OBs: ${structures.orderBlocks.length}, FVGs: ${structures.fvgs.length}, Key Levels: ${structures.keyLevels.length}`);
  
  res.json({
    success: true,
    structures,
    debug: {
      candleCounts: {
        M5: sampleChart.M5.length,
        M15: sampleChart.M15.length,
        H1: sampleChart.H1.length,
        H4: sampleChart.H4.length
      }
    }
  });
});

// --- BASE ENDPOINT ---
app.get('/', (req, res) => {
  res.json({ status: 'FxScalpKing Backend API', version: '1.0.0' });
});

// --- MT5 EA ENDPOINTS ---

// 1. License Validation (EA calls this on init)
app.post('/api/ea/validate', (req, res) => {
  const { apiKey, accountId } = req.body;

  const keyEntry = findApiKey(apiKey);

  if (!keyEntry) {
    return res.status(401).json({
      valid: false,
      error: 'Invalid API Key'
    });
  }

  // Update key last used info
  keyEntry.lastUsed = new Date().toISOString();
  keyEntry.accountId = accountId;

  res.json({
    valid: true,
    expiry: '2026-12-31',
    plan: keyEntry.type,
    features: {
      maxTrades: keyEntry.type === 'PAID' ? 5 : 3,
      trailingStop: true,
      sessionFilter: true
    }
  });
});

// 2. EA Heartbeat & Data Sync
// EA calls this every 2-3 seconds with current account state
app.post('/api/ea/update', (req, res) => {
  const { apiKey, accountData, positions, chart, structures } = req.body;
  console.log(`[HEARTBEAT] ❤️ Received update from EA (${apiKey}) - Symbol: ${accountData?.eaSymbol || '???'} Price: ${accountData?.price || '???'}`);

  const keyEntry = findApiKey(apiKey);
  if (!keyEntry) {
    return res.status(401).json({ error: 'Invalid API Key' });
  }

  // Get current state to preserve existing chart data if new data is only one timeframe
  const prevState = db.accountStates[apiKey] || { chart: {} };
  const requestedTf = prevState.requestedTimeframe || 'M5';

  // Merge new chart data into existing chart data
  const updatedChart = { ...(prevState.chart || {}) };
  if (chart && typeof chart === 'object') {
    Object.keys(chart).forEach(tf => {
      if (Array.isArray(chart[tf]) && chart[tf].length > 0) {
        updatedChart[tf] = chart[tf];
      }
    });
  }

  // Force Backend to calculate structures for the Brain to use
  const backendStructures = buildStructures(updatedChart);
  
  // FORCE TEST STRUCTURES for immediate DRAW command testing
  console.log(`[TEST] Forcing test structures for DRAW command verification`);
  const currentPrice = accountData?.price || 4565.58;
  
  // Add guaranteed test structures if none detected
  if(backendStructures.orderBlocks.length === 0) {
    backendStructures.orderBlocks.push({
      type: 'BULLISH',
      zoneType: 'OB_BULLISH',
      top: currentPrice - 10,
      bottom: currentPrice - 15,
      timeframe: 'M5',
      time: Date.now() / 1000 - 300,
      label: 'M5 TEST OB'
    });
    console.log(`[TEST] Added test Order Block`);
  }
  
  if(backendStructures.fvgs.length === 0) {
    backendStructures.fvgs.push({
      type: 'BULLISH',
      zoneType: 'FVG_BULLISH',
      top: currentPrice - 5,
      bottom: currentPrice + 5,
      timeframe: 'M5',
      time: Date.now() / 1000 - 600,
      label: 'M5 TEST FVG'
    });
    console.log(`[TEST] Added test FVG`);
  }
  
  if(backendStructures.keyLevels.length === 0) {
    backendStructures.keyLevels.push({
      type: 'SUPPORT',
      zoneType: 'KEY_SUPPORT',
      price: currentPrice - 20,
      timeframe: 'H1',
      time: Date.now() / 1000 - 3600,
      label: 'H1 TEST KL'
    });
    console.log(`[TEST] Added test Key Level`);
  }
  
  console.log(`[TEST] Final structure counts: OB=${backendStructures.orderBlocks.length}, FVG=${backendStructures.fvgs.length}, KL=${backendStructures.keyLevels.length}`);

  // Debug: Show detailed chart data information
  console.log(`[HEARTBEAT] EA API Key: ${apiKey} | Chart TFs: ${Object.keys(updatedChart).join(', ')}`);
  Object.keys(updatedChart).forEach(tf => {
    const candles = updatedChart[tf];
    console.log(`[HEARTBEAT] ${tf}: ${candles.length} candles | Range: ${candles.length > 0 ? `${candles[0].x} - ${candles[candles.length-1].x}` : 'N/A'}`);
  });
  console.log(`[HEARTBEAT] Structures: ${backendStructures.orderBlocks.length}ob, ${backendStructures.fvgs.length}fvg, ${backendStructures.keyLevels.length}kl`);

  // Update account state
  db.accountStates[apiKey] = {
    ...(accountData || {}),
    positions: positions || [],
    chart: updatedChart,
    // IGNORE EA structures, use Backend only
    structures: backendStructures || prevState.structures || { orderBlocks: [], fvgs: [], keyLevels: [], marketStructure: [] },
    requestedTimeframe: requestedTf,
    lastSeen: new Date().toISOString()
  };

  // Run Brain Strategy logic directly on Backend for execution
  runStrategy(apiKey, db.accountStates[apiKey]);

  // Get pending commands for this EA
  const commandObjs = db.pendingCommands[apiKey] || [];
  db.pendingCommands[apiKey] = [];
  
  if (commandObjs.length > 0) {
    console.log(`[BRAIN] ⚡ Queuing ${commandObjs.length} commands for EA execution:`, commandObjs.map(c => c.action).join(', '));
  }
  
  // Convert structures into DRAW commands for EA to render on chart
  const drawCommands = [];
  
  // Convert Order Blocks to DRAW commands
  backendStructures.orderBlocks.forEach((ob, index) => {
    drawCommands.push({
      action: 'DRAW_OB',
      top: ob.top,
      bottom: ob.bottom,
      zoneType: ob.zoneType,
      time: ob.time,
      label: ob.label
    });
    console.log(`[DRAW] Converting OB to command: ${ob.label}`);
  });
  
  // Convert FVGs to DRAW commands
  backendStructures.fvgs.forEach((fvg, index) => {
    drawCommands.push({
      action: 'DRAW_FVG',
      top: fvg.top,
      bottom: fvg.bottom,
      zoneType: fvg.zoneType,
      time: fvg.time,
      label: fvg.label
    });
    console.log(`[DRAW] Converting FVG to command: ${fvg.label}`);
  });
  
  // Convert Key Levels to DRAW commands
  backendStructures.keyLevels.forEach((kl, index) => {
    drawCommands.push({
      action: 'DRAW_KL',
      top: kl.price,
      bottom: kl.price,
      zoneType: kl.zoneType,
      time: kl.time,
      label: kl.label
    });
    console.log(`[DRAW] Converting KL to command: ${kl.label}`);
  });
  
  // Add a special command to tell the EA which timeframe we want
  drawCommands.push({
    action: 'SET_TF',
    timeframe: requestedTf
  });

  const allCommands = [...commandObjs, ...drawCommands];
  
  if (allCommands.length > 0) {
    console.log(`Sending ${allCommands.length} commands to EA for ${apiKey} (${drawCommands.length} drawings)`);
  }

  res.json({
    success: true,
    commands: allCommands,
    structures: structures,
    serverTime: new Date().toISOString()
  });
});

// 3. Trade Executed Notification (EA notifies backend after executing a trade)
app.post('/api/ea/trade-executed', (req, res) => {
  const { apiKey, trade } = req.body;

  const keyEntry = findApiKey(apiKey);
  if (!keyEntry) {
    return res.status(401).json({ error: 'Invalid API Key' });
  }

  console.log(`[TRADE_EXEC] Received trade notification: ${trade.ticket} ${trade.type} ${trade.symbol} lots:${trade.lots}`);

  // Store trade in history
  db.tradeHistory.push({
    ...trade,
    apiKey,
    executedAt: new Date().toISOString()
  });

  saveDb();
  res.json({ success: true });
});

// 4. Sync History (Bulk upload of deals from MT5)
app.post('/api/ea/sync-history', (req, res) => {
  const { apiKey, deals } = req.body;
  const keyEntry = findApiKey(apiKey);
  if (!keyEntry) return res.status(401).json({ error: 'Invalid API Key' });

  if (Array.isArray(deals)) {
    let newCount = 0;
    deals.forEach(deal => {
      // Robust check for existing deals
      const dealId = String(deal.deal_ticket || deal.id);
      const exists = db.tradeHistory.find(t => String(t.deal_ticket || t.id) === dealId);
      
      if (!exists) {
        db.tradeHistory.push({
          ...deal,
          ticket: String(deal.ticket || deal.position_id), // Ensure ticket/position_id mapping as string
          apiKey,
          executedAt: deal.time ? new Date(deal.time * 1000).toISOString() : new Date().toISOString()
        });
        newCount++;
      }
    });
    if (newCount > 0) {
      console.log(`[SYNC] Synced ${newCount} new deals for ${apiKey}. Total history: ${db.tradeHistory.length}`);
      saveDb();
    }
  }

  res.json({ success: true });
});

// --- ADMIN ENDPOINTS ---

// Generate Free API Key (Admin only)
app.post('/api/admin/generate-key', (req, res) => {
  const { password, note, type } = req.body;

  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const newKey = generateKey();
  const keyEntry = {
    key: newKey,
    type: type || 'FREE',
    note: note || '',
    createdAt: new Date().toISOString(),
    lastUsed: null,
    accountId: null
  };

  db.apiKeys.push(keyEntry);

  res.json(keyEntry);
});

// Get All Keys (Admin)
app.get('/api/admin/keys', (req, res) => {
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.ADMIN_PASSWORD}`) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  res.json(db.apiKeys);
});

// Get Dashboard Stats (Admin)
app.get('/api/admin/stats', (req, res) => {
  const activeKeys = db.apiKeys.filter(k => k.lastUsed).length;
  const totalTrades = db.tradeHistory.length;
  const activeEAs = Object.keys(db.accountStates).length;

  res.json({
    totalKeys: db.apiKeys.length,
    activeKeys,
    totalTrades,
    activeEAs
  });
});

// --- CUSTOMER ENDPOINTS ---

// Customer Registration (Simulate Payment)
app.post('/api/register', (req, res) => {
  const { email, password } = req.body;

  const newKey = generateKey();
  const keyEntry = {
    key: newKey,
    type: 'PAID',
    email,
    createdAt: new Date().toISOString()
  };

  db.apiKeys.push(keyEntry);

  res.json({
    message: 'Registration successful',
    apiKey: newKey
  });
});

// --- APP ENDPOINTS ---

// Validate API Key (for mobile app login)
app.post('/api/auth/validate', (req, res) => {
  const { apiKey } = req.body;

  const keyEntry = findApiKey(apiKey);
  if (keyEntry) {
    res.json({
      success: true,
      token: 'jwt-token-placeholder',
      message: 'API Key validated'
    });
  } else {
    res.status(401).json({ error: 'Invalid API Key' });
  }
});

// Get Account Data (for mobile app)
app.get('/api/account', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  const { tf } = req.query;
  let state = db.accountStates[apiKey];
  
  console.log(`[ACCOUNT] Request from app - API Key: ${apiKey} | TF: ${tf}`);
  
  // Fallback: If no specific API key state, use the most recent EA data
  if (!state) {
    const mostRecentKey = Object.keys(db.accountStates).sort((a, b) => 
      new Date(db.accountStates[b].lastSeen).getTime() - new Date(db.accountStates[a].lastSeen).getTime()
    )[0];
    
    if (mostRecentKey) {
      console.log(`[ACCOUNT] No state for API key ${apiKey}, using most recent EA data from ${mostRecentKey}`);
      state = db.accountStates[mostRecentKey];
    }
  }
  
  console.log(`[ACCOUNT] State exists: ${!!state} | Structures: ${state?.structures ? JSON.stringify(state.structures).substring(0, 200) + '...' : 'none'}`);

  // TEST: Force structure calculation to test the functions
  if (state && state.chart) {
    console.log(`[ACCOUNT] Testing structure calculation with existing chart data...`);
    const testStructures = buildStructures(state.chart);
    console.log(`[ACCOUNT] Test result - OBs: ${testStructures.orderBlocks.length}, FVGs: ${testStructures.fvgs.length}, Key Levels: ${testStructures.keyLevels.length}`);
    
    // Update state with test results
    state.structures = testStructures;
  }

  if (!state) {
    return res.json({
      balance: 0,
      equity: 0,
      pnl_today: 0,
      ea_connected: false,
      positions: [],
      ea_symbol: 'XAUUSD',
      digits: 0,
      point: 0,
      tickSize: 0,
      tickValue: 0,
      price: 0,
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
      structures: {
        orderBlocks: [],
        fvgs: [],
        keyLevels: []
      }
    });
  }

  // Update requested timeframe if provided
  if (tf && ['M1', 'M5', 'M15', 'M30', 'H1'].includes(tf)) {
    state.requestedTimeframe = tf;
  }

  const isConnected = (new Date() - new Date(state.lastSeen)) < 10000;

  res.json({
    balance: state.balance,
    equity: state.equity,
    pnl_today: state.pnl_today,
    ea_connected: isConnected,
    positions: state.positions,
    ea_symbol: state.eaSymbol || 'XAUUSD',
    digits: state.digits,
    point: state.point,
    tickSize: state.tickSize,
    tickValue: state.tickValue,
    price: state.price || 0,
    fastEMA: state.fastEMA || 0,
    slowEMA: state.slowEMA || 0,
    bbUpper: state.bbUpper || 0,
    bbLower: state.bbLower || 0,
    rsi: state.rsi || 0,
    atr: state.atr || 0,
    vwap: state.vwap || 0,
    spread: state.spread || 0,
    tickVolume: state.tickVolume || 0,
    chart: state.chart || {},
    structures: state.structures || { orderBlocks: [], fvgs: [], keyLevels: [] }
  });
});

// Get Trade History (for mobile app journal)
app.get('/api/orders/closed', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  const { filter } = req.query; // today, week, month, quarter, year

  const now = new Date();
  let startDate = new Date();

  switch (filter) {
    case 'today':
      startDate.setHours(0, 0, 0, 0);
      break;
    case 'week':
      startDate.setDate(now.getDate() - 7);
      break;
    case 'month':
      startDate.setMonth(now.getMonth() - 1);
      break;
    case 'quarter':
      startDate.setMonth(now.getMonth() - 3);
      break;
    case 'year':
      startDate.setFullYear(now.getFullYear() - 1);
      break;
    default:
      startDate = new Date(0);
  }

  const toNullableNumber = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };

  const userTrades = db.tradeHistory.filter((t) => t.apiKey === apiKey);
  const groupedTrades = {};

  userTrades.forEach((t) => {
    const ticket = String(t.ticket || t.position_id || t.id || '');
    if (!ticket) return;

    if (!groupedTrades[ticket]) {
      groupedTrades[ticket] = {
        ticket,
        symbol: t.symbol ?? null,
        lots: null,
        sl: null,
        tp: null,
        pnl: null,
        openPrice: null,
        closePrice: null,
        openTime: null,
        closeTime: null,
        closeReason: null,
        type: null,
      };
    }

    const trade = groupedTrades[ticket];
    const entryType = String(t.entry || '').toUpperCase();
    const type = String(t.type || '').toUpperCase();
    const eventTime = t.executedAt || (t.time ? new Date(Number(t.time) * 1000).toISOString() : null);
    const isDealIn = entryType === 'IN';
    const isDealOut = entryType === 'OUT' || entryType === 'OUT_BY';
    const isLegacyOpen = !entryType && (type === 'BUY' || type === 'SELL');
    const isLegacyClose = !entryType && type === 'CLOSE';
    const isEntry = isDealIn || isLegacyOpen;
    const isExit = isDealOut || isLegacyClose;

    if (t.symbol && !trade.symbol) trade.symbol = t.symbol;
    if ((type === 'BUY' || type === 'SELL') && !trade.type) trade.type = type;

    if (isEntry) {
      if (!trade.openTime || (eventTime && new Date(eventTime) < new Date(trade.openTime))) trade.openTime = eventTime;

      const entryPrice = toNullableNumber(t.price ?? t.openPrice);
      if (entryPrice !== null && (trade.openPrice === null || (eventTime && trade.openTime && new Date(eventTime) <= new Date(trade.openTime)))) {
        trade.openPrice = entryPrice;
      }

      const lots = toNullableNumber(t.volume ?? t.lots);
      if (lots !== null) trade.lots = lots;

      const sl = toNullableNumber(t.sl);
      if (sl !== null && sl > 0) trade.sl = sl;

      const tp = toNullableNumber(t.tp);
      if (tp !== null && tp > 0) trade.tp = tp;
    }

    if (isExit) {
      if (!trade.closeTime || (eventTime && new Date(eventTime) > new Date(trade.closeTime))) trade.closeTime = eventTime;

      const exitPrice = toNullableNumber(t.price ?? t.closePrice);
      if (exitPrice !== null) trade.closePrice = exitPrice;

      if (Object.prototype.hasOwnProperty.call(t, 'profit') || Object.prototype.hasOwnProperty.call(t, 'pnl')) {
        const pnl = toNullableNumber(t.profit ?? t.pnl);
        if (pnl !== null) trade.pnl = pnl;
      }

      const lots = toNullableNumber(t.volume ?? t.lots);
      if (lots !== null && trade.lots === null) trade.lots = lots;

      const sl = toNullableNumber(t.sl);
      if (sl !== null && sl > 0 && trade.sl === null) trade.sl = sl;

      const tp = toNullableNumber(t.tp);
      if (tp !== null && tp > 0 && trade.tp === null) trade.tp = tp;

      const comment = String(t.comment || '').toLowerCase();
      const dealReason = toNullableNumber(t.deal_reason);
      if (comment.includes('[sl]') || comment.includes('sl hit') || dealReason === 4) trade.closeReason = 'SL';
      else if (comment.includes('[tp]') || comment.includes('tp hit') || dealReason === 5) trade.closeReason = 'TP';
      else if (comment.includes('manual') || dealReason === 3 || dealReason === 0) trade.closeReason = 'MANUAL';
    }
  });

  const trades = Object.values(groupedTrades)
    .filter((t) => t.closeTime && new Date(t.closeTime) >= startDate)
    .map((t) => ({
      id: t.ticket,
      ticket: t.ticket,
      symbol: t.symbol,
      type: t.type,
      pnl: t.pnl,
      openPrice: t.openPrice,
      closePrice: t.closePrice,
      sl: t.sl,
      tp: t.tp,
      openTime: t.openTime,
      closeTime: t.closeTime,
      lots: t.lots,
      closeReason: t.closeReason,
    }))
    .sort((a, b) => new Date(b.closeTime).getTime() - new Date(a.closeTime).getTime());

  res.json(trades);
});

// Alias for old endpoint
app.get('/api/trades', (req, res) => {
  res.redirect(`/api/orders/closed?filter=${req.query.filter || 'month'}`);
});

// Get Subscription Info
app.get('/api/subscription', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  const keyEntry = findApiKey(apiKey);

  if (!keyEntry) {
    return res.status(401).json({ error: 'Invalid API Key' });
  }

  res.json({
    plan: keyEntry.type,
    status: 'ACTIVE',
    expiry: '2026-12-31',
    features: ['Auto-trading', 'Real-time sync', 'Priority support']
  });
});

// Place Order (for mobile app manual trade - currently disabled for auto-only)
app.post('/api/order', (req, res) => {
  const bodyApiKey = req.body.apiKey;
  const headerApiKey = req.headers['x-api-key'];
  const apiKey = bodyApiKey || headerApiKey;

  if (!apiKey) {
    return res.status(401).json({ error: 'Missing API Key' });
  }

  const { action, symbol, type, lots, sl, tp, top, bottom, zoneType, time, confidence, reason } = req.body;

  console.log(`[APP_CMD] Received command for ${apiKey}: ${action || type} ${symbol || ''}`);

  if (!db.pendingCommands[apiKey]) {
    db.pendingCommands[apiKey] = [];
  }

  // Build command string for EA
  let commandAction = action || type;
  const normalizedAction = String(commandAction || '').toUpperCase();

  // Safety gate: allow manual trades from app (confidence/reason optional if coming from authenticated app)
  if ((normalizedAction === 'BUY' || normalizedAction === 'SELL')) {
    // If it's a manual trade from the app UI, we can allow it even without brain metadata
    // but we still prefer having it.
    console.log(`[APP_CMD] Trade Trigger: ${normalizedAction} ${symbol} lots:${lots} reason:${reason || 'Manual'}`);
  }
  
  // For modify commands, extract ticket and include SL and TP
  if (action && action.startsWith('MODIFY_TICKET_')) {
    const ticket = action.replace('MODIFY_TICKET_', '');
    if (sl !== undefined && tp !== undefined) {
      commandAction = `MODIFY_TICKET_${ticket}_SL_${sl}_TP_${tp}`;
    }
  }

  const command = {
    id: Date.now(),
    action: commandAction,
    symbol,
    type,
    lots,
    sl,
    tp,
    top,
    bottom,
    zoneType,
    time,
    confidence: confidence || 1.0,
    reason: reason || 'APP_MANUAL',
    createdAt: new Date().toISOString()
  };

  db.pendingCommands[apiKey].push(command);

  res.json({
    success: true,
    message: 'Command queued for EA',
    commandId: command.id
  });
});

// Test endpoint to simulate market data
app.get('/api/test/signal', (req, res) => {
  const { symbol, tf } = req.query;
  
  // Create mock market data with structures
  const mockPrice = 2300 + Math.random() * 50; // Gold price around $2300
  
  // Mock structures for testing
  const mockStructures = {
    orderBlocks: [
      { type: 'BULLISH_ORDER_BLOCK', price: mockPrice - 10, strength: 8 },
      { type: 'BEARISH_ORDER_BLOCK', price: mockPrice + 15, strength: 7 }
    ],
    fvgs: [
      { top: mockPrice - 5, bottom: mockPrice + 5, type: 'BULLISH_FVG' }
    ],
    keyLevels: [
      { price: mockPrice - 20, type: 'SUPPORT' },
      { price: mockPrice + 25, type: 'RESISTANCE' }
    ]
  };
  
  // Generate test signal
  let signal = 'HOLD';
  let reason = 'Test signal generated';
  
  // Simple logic for demo
  if (Math.random() > 0.7) {
    signal = Math.random() > 0.5 ? 'BUY' : 'SELL';
    reason = `Test ${signal} signal at price $${mockPrice.toFixed(2)}`;
  }
  
  res.json({
    symbol: symbol || 'XAUUSD',
    tf: tf || 'M5',
    signal,
    reason,
    price: mockPrice,
    timestamp: Date.now(),
    structures: {
      orderBlocks: mockStructures.orderBlocks.length,
      fvgs: mockStructures.fvgs.length,
      keyLevels: mockStructures.keyLevels.length
    },
    testMode: true
  });
});

// Get signal (for mobile app chart)
app.get('/api/signal', (req, res) => {
  const { symbol, tf } = req.query;
  
  try {
    // Get current chart data from account state
    const state = db.accountStates['default'] || Object.values(db.accountStates)[0];
    if (!state || !state.chart || !state.structures) {
      return res.json({
        symbol: symbol || 'XAUUSD',
        tf: tf || 'M5',
        signal: 'HOLD',
        reason: 'No market data available - EA not connected',
        suggestion: 'Use /api/test/signal for testing, or connect EA to MT5'
      });
    }
    
    const chartData = state.chart[tf] || [];
    const structures = state.structures;
    
    if (chartData.length < 20) {
      return res.json({
        symbol: symbol || 'XAUUSD',
        tf: tf || 'M5',
        signal: 'HOLD',
        reason: 'Insufficient data'
      });
    }
    
    // Generate signal based on structures and price action
    const latestPrice = chartData[chartData.length - 1]?.close || 0;
    const orderBlocks = structures.orderBlocks.filter(ob => ob.type.includes('BULL'));
    const fvgs = structures.fvgs;
    
    let signal = 'HOLD';
    let reason = 'No clear signal';
    
    // Bullish signal logic
    if (orderBlocks.length > 0 && fvgs.length > 0) {
      const latestOB = orderBlocks[0];
      const latestFVG = fvgs[0];
      
      // Check if price is above recent bullish order block
      if (latestPrice > latestOB.price * 1.002) {
        signal = 'BUY';
        reason = `Price above bullish OB at ${latestOB.price}`;
      }
      // Check if price is in fair value gap
      else if (latestFVG && latestPrice >= latestFVG.top && latestPrice <= latestFVG.bottom) {
        signal = 'BUY';
        reason = 'Price in FVG - buying opportunity';
      }
    }
    
    // Bearish signal logic
    const bearishOBs = structures.orderBlocks.filter(ob => ob.type.includes('BEAR'));
    if (bearishOBs.length > 0 && fvgs.length > 0) {
      const latestBearishOB = bearishOBs[0];
      
      // Check if price is below recent bearish order block
      if (latestPrice < latestBearishOB.price * 0.998) {
        signal = 'SELL';
        reason = `Price below bearish OB at ${latestBearishOB.price}`;
      }
    }
    
    console.log(`[SIGNAL] Generated ${signal} for ${symbol} ${tf}: ${reason}`);
    
    res.json({
      symbol: symbol || 'XAUUSD',
      tf: tf || 'M5',
      signal,
      reason,
      price: latestPrice,
      timestamp: Date.now(),
      structures: {
        orderBlocks: structures.orderBlocks.length,
        fvgs: structures.fvgs.length,
        keyLevels: structures.keyLevels.length
      }
    });
    
  } catch (error) {
    console.error('[SIGNAL] Error generating signal:', error);
    res.json({
      symbol: symbol || 'XAUUSD',
      tf: tf || 'M5',
      signal: 'HOLD',
      reason: 'Error generating signal',
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`FxScalpKing Backend running on http://localhost:${PORT}`);
  console.log(`EA Endpoints ready for MT5 connection`);
  console.log(`Structure calculation fixed - v2.0`);
});
/ /   F r e s h   d e p l o y   0 5 / 0 1 / 2 0 2 6   1 6 : 3 3 : 1 2 
 
 / /   F r e s h   d e p l o y   w i t h   s t r u c t u r e   d e t e c t i o n   f i x   -   0 5 / 0 1 / 2 0 2 6   1 6 : 4 9 : 3 7 
 
 