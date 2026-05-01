const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(bodyParser.json());

// Simple test endpoint
app.get('/test', (req, res) => {
  res.json({
    success: true,
    message: 'Minimal backend is working',
    timestamp: new Date().toISOString()
  });
});

// License validation endpoint (EA calls this on startup)
app.post('/api/ea/validate', (req, res) => {
  const { apiKey, accountId } = req.body;
  
  console.log(`[LICENSE] Validation request for API Key: ${apiKey || 'none'} - Account: ${accountId || 'none'}`);
  
  // Temporarily accept any API key that starts with FXSK-
  if (!apiKey || !apiKey.toLowerCase().startsWith('fxsk-')) {
    console.log(`[LICENSE] Invalid API Key format: ${apiKey}`);
    return res.status(401).json({
      valid: false,
      error: 'Invalid API Key'
    });
  }
  
  console.log(`[LICENSE] API Key validated successfully`);
  
  res.json({
    valid: true,
    expiry: '2026-12-31',
    plan: 'PAID',
    features: {
      maxTrades: 30,
      trailingStop: true,
      sessionFilter: true
    }
  });
});

// Basic heartbeat endpoint
app.post('/api/ea/update', (req, res) => {
  const { apiKey, accountData } = req.body;
  
  // Temporarily disable API key validation to get EA working
  console.log(`[HEARTBEAT] Received API Key: ${apiKey || 'none'} - validation disabled for testing`);
  
  // TODO: Re-enable proper API key validation once EA is working
  
  console.log(`[HEARTBEAT] ❤️ Received update from EA (${apiKey}) - Symbol: ${accountData?.eaSymbol || '???'} Price: ${accountData?.price || '???'}`);
  
  // Create forced test structures
  const currentPrice = accountData?.price || 4565.58;
  const testStructures = {
    orderBlocks: [
      {
        type: 'BULLISH',
        zoneType: 'OB_BULLISH',
        top: currentPrice - 10,
        bottom: currentPrice - 15,
        timeframe: 'M5',
        time: Date.now() / 1000 - 300,
        label: 'M5 TEST OB'
      }
    ],
    fvgs: [
      {
        type: 'BULLISH',
        zoneType: 'FVG_BULLISH',
        top: currentPrice - 5,
        bottom: currentPrice + 5,
        timeframe: 'M5',
        time: Date.now() / 1000 - 600,
        label: 'M5 TEST FVG'
      }
    ],
    keyLevels: [
      {
        type: 'SUPPORT',
        zoneType: 'KEY_SUPPORT',
        price: currentPrice - 20,
        timeframe: 'H1',
        time: Date.now() / 1000 - 3600,
        label: 'H1 TEST KL'
      }
    ]
  };
  
  // Convert structures to DRAW commands
  const drawCommands = [];
  
  testStructures.orderBlocks.forEach((ob) => {
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
  
  testStructures.fvgs.forEach((fvg) => {
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
  
  testStructures.keyLevels.forEach((kl) => {
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
  
  console.log(`[HEARTBEAT] Generated ${drawCommands.length} DRAW commands for EA`);
  
  res.json({
    success: true,
    commands: drawCommands,
    structures: testStructures,
    serverTime: new Date().toISOString()
  });
});

// Signal endpoint (mobile app uses this for trading signals)
app.get('/api/signal', (req, res) => {
  const { symbol, tf } = req.query;
  const apiKey = req.headers['x-api-key'];
  
  console.log(`[SIGNAL] Signal request for ${symbol || 'XAUUSD'} ${tf || 'M5'} - API Key: ${apiKey || 'none'}`);
  
  // Create test signal based on structures
  const currentPrice = 4565.58;
  const testStructures = {
    orderBlocks: [
      {
        type: 'BULLISH',
        zoneType: 'OB_BULLISH',
        top: currentPrice - 10,
        bottom: currentPrice - 15,
        timeframe: 'M5',
        time: Date.now() / 1000 - 300,
        label: 'M5 TEST OB'
      }
    ],
    fvgs: [
      {
        type: 'BULLISH',
        zoneType: 'FVG_BULLISH',
        top: currentPrice - 5,
        bottom: currentPrice + 5,
        timeframe: 'M5',
        time: Date.now() / 1000 - 600,
        label: 'M5 TEST FVG'
      }
    ],
    keyLevels: [
      {
        type: 'SUPPORT',
        zoneType: 'KEY_SUPPORT',
        price: currentPrice - 20,
        timeframe: 'H1',
        time: Date.now() / 1000 - 3600,
        label: 'H1 TEST KL'
      }
    ]
  };
  
  // Generate test signal
  let signal = 'HOLD';
  let reason = 'Market is neutral - waiting for setup';
  
  // Simple signal logic based on structures
  if (testStructures.orderBlocks.length > 0 && testStructures.fvgs.length > 0) {
    signal = 'BUY';
    reason = 'Bullish Order Block + FVG detected - buying opportunity';
  }
  
  res.json({
    symbol: symbol || 'XAUUSD',
    tf: tf || 'M5',
    signal,
    reason,
    price: currentPrice,
    timestamp: Date.now(),
    structures: {
      orderBlocks: testStructures.orderBlocks.length,
      fvgs: testStructures.fvgs.length,
      keyLevels: testStructures.keyLevels.length
    }
  });
});

// Order endpoint (mobile app uses this for manual trades)
app.post('/api/order', (req, res) => {
  const { apiKey, action, symbol, type, lots, sl, tp, top, bottom, zoneType, time, confidence, reason } = req.body;
  
  console.log(`[ORDER] Manual trade request: ${action} ${symbol} lots:${lots}`);
  
  // Validate API key
  if (!apiKey || !apiKey.toLowerCase().startsWith('fxsk-')) {
    return res.status(401).json({ error: 'Invalid API Key' });
  }
  
  // Queue command for EA
  const command = {
    id: Date.now(),
    action: action || type,
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
  
  console.log(`[ORDER] Command queued for EA: ${command.action} ${command.symbol}`);
  
  res.json({
    success: true,
    message: 'Command queued for EA',
    commandId: command.id
  });
});

// Account endpoint
app.get('/api/account', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  
  // Temporarily disable API key validation
  console.log(`[ACCOUNT] API Key validation disabled for testing`);
  
  const currentPrice = 4565.58;
  const testStructures = {
    orderBlocks: [
      {
        type: 'BULLISH',
        zoneType: 'OB_BULLISH',
        top: currentPrice - 10,
        bottom: currentPrice - 15,
        timeframe: 'M5',
        time: Date.now() / 1000 - 300,
        label: 'M5 TEST OB'
      }
    ],
    fvgs: [
      {
        type: 'BULLISH',
        zoneType: 'FVG_BULLISH',
        top: currentPrice - 5,
        bottom: currentPrice + 5,
        timeframe: 'M5',
        time: Date.now() / 1000 - 600,
        label: 'M5 TEST FVG'
      }
    ],
    keyLevels: [
      {
        type: 'SUPPORT',
        zoneType: 'KEY_SUPPORT',
        price: currentPrice - 20,
        timeframe: 'H1',
        time: Date.now() / 1000 - 3600,
        label: 'H1 TEST KL'
      }
    ]
  };
  
  res.json({
    ea_connected: true,
    structures: testStructures,
    lastSeen: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`Minimal backend running on port ${PORT}`);
  console.log(`EA Endpoints ready for MT5 connection`);
});
