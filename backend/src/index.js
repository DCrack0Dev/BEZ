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

// Mobile app auth validation endpoint
app.post('/api/auth/validate', (req, res) => {
  const { apiKey } = req.body;
  
  console.log(`[AUTH] Mobile app validation request for API Key: ${apiKey || 'none'}`);
  
  // Temporarily accept any API key that starts with FXSK-
  if (!apiKey || !apiKey.toLowerCase().startsWith('fxsk-')) {
    console.log(`[AUTH] Invalid API Key format: ${apiKey}`);
    return res.status(401).json({
      valid: false,
      error: 'Invalid API Key'
    });
  }
  
  console.log(`[AUTH] API Key validated successfully`);
  
  res.json({
    token: 'mock-jwt-token-' + Date.now(),
    valid: true,
    expiry: '2026-12-31',
    plan: 'PAID'
  });
});

// Mobile app account data endpoint
app.get('/api/account', (req, res) => {
  console.log(`[ACCOUNT] Mobile app requesting account data`);
  
  const currentPrice = 4565.58;
  const now = Date.now();
  
  // Generate sample chart data for different timeframes
  const generateChartData = (timeframe, candleCount = 200) => {
    const data = [];
    let basePrice = currentPrice;
    const candleInterval = timeframe === 'M5' ? 300000 : timeframe === 'M15' ? 900000 : timeframe === 'H1' ? 3600000 : 14400000;
    
    for (let i = candleCount - 1; i >= 0; i--) {
      const timestamp = now - (i * candleInterval);
      const volatility = timeframe === 'M5' ? 0.5 : timeframe === 'M15' ? 0.8 : 1.2;
      const random = Math.random() - 0.5;
      const change = random * volatility;
      
      const open = basePrice;
      const close = basePrice + change;
      const high = Math.max(open, close) + Math.random() * 0.3;
      const low = Math.min(open, close) - Math.random() * 0.3;
      
      data.push({
        x: timestamp / 1000, // Unix timestamp in seconds
        open: parseFloat(open.toFixed(5)),
        high: parseFloat(high.toFixed(5)),
        low: parseFloat(low.toFixed(5)),
        close: parseFloat(close.toFixed(5))
      });
      
      basePrice = close;
    }
    
    return data;
  };
  
  // Generate structures for each timeframe
  const generateStructures = (timeframe) => ({
    orderBlocks: [
      {
        type: 'BULLISH',
        zoneType: 'OB_BULLISH',
        top: currentPrice - 12,
        bottom: currentPrice - 20,
        timeframe: timeframe,
        time: now / 1000 - 1800,
        label: `${timeframe} OB`
      },
      {
        type: 'BEARISH',
        zoneType: 'OB_BEARISH',
        top: currentPrice + 20,
        bottom: currentPrice + 12,
        timeframe: timeframe,
        time: now / 1000 - 3600,
        label: `${timeframe} OB`
      }
    ],
    fvgs: [
      {
        type: 'BULLISH',
        zoneType: 'FVG_BULLISH',
        top: currentPrice - 6,
        bottom: currentPrice + 6,
        timeframe: timeframe,
        time: now / 1000 - 900,
        label: `${timeframe} FVG`
      },
      {
        type: 'BEARISH',
        zoneType: 'FVG_BEARISH',
        top: currentPrice + 6,
        bottom: currentPrice - 6,
        timeframe: timeframe,
        time: now / 1000 - 1800,
        label: `${timeframe} FVG`
      }
    ],
    keyLevels: [
      {
        type: 'HIGHER_HIGH',
        zoneType: 'HH_H1',
        price: currentPrice + 35,
        timeframe: 'H1',
        time: now / 1000 - 7200,
        label: 'H1 HH'
      },
      {
        type: 'LOWER_LOW',
        zoneType: 'LL_H1',
        price: currentPrice - 40,
        timeframe: 'H1',
        time: now / 1000 - 7200,
        label: 'H1 LL'
      }
    ]
  });
  
  res.json({
    balance: 200000,
    equity: 205000,
    margin: 0,
    freeMargin: 205000,
    marginLevel: 0,
    profit: 5000,
    pnl_today: 5000,
    ea_connected: true,
    eaSymbol: 'BTCUSD',
    price: currentPrice,
    fastEMA: 4568.23,
    slowEMA: 4562.87,
    bbUpper: 4575.50,
    bbLower: 4550.25,
    rsi: 58.4,
    chart: {
      M5: generateChartData('M5'),
      M15: generateChartData('M15'),
      H1: generateChartData('H1'),
      H4: generateChartData('H4')
    },
    positions: [
      {
        ticket: "123456",
        symbol: "BTCUSD",
        type: "BUY",
        volume: 0.1,
        openPrice: 4560.25,
        sl: 4550.00,
        tp: 4580.00,
        profit: 52.33,
        swap: 0.15,
        time: now - 3600000
      }
    ],
    structures: {
      M5: generateStructures('M5'),
      M15: generateStructures('M15'),
      H1: generateStructures('H1'),
      H4: generateStructures('H4')
    },
    lastSeen: new Date().toISOString()
  });
});

// Basic heartbeat endpoint
app.post('/api/ea/update', (req, res) => {
  const { apiKey, accountData } = req.body;
  
  // Temporarily disable API key validation to get EA working
  console.log(`[HEARTBEAT] Received API Key: ${apiKey || 'none'} - validation disabled for testing`);
  
  // TODO: Re-enable proper API key validation once EA is working
  
  console.log(`[HEARTBEAT] ❤️ Received update from EA (${apiKey}) - Symbol: ${accountData?.eaSymbol || '???'} Price: ${accountData?.price || '???'} - SIMPLIFIED STRUCTURES`);
  
  // Create clean simple structures: 1hr HH/LL, 15min OB, 5min FVG
  const currentPrice = accountData?.price || 4565.58;
  const testStructures = {
    orderBlocks: [
      // Only 15 Min Order Blocks (2 recent ones)
      {
        type: 'BULLISH',
        zoneType: 'OB_BULLISH',
        top: currentPrice - 12,
        bottom: currentPrice - 20,
        timeframe: 'M15',
        time: Date.now() / 1000 - 1800,
        label: 'M15 OB'
      },
      {
        type: 'BEARISH',
        zoneType: 'OB_BEARISH',
        top: currentPrice + 20,
        bottom: currentPrice + 12,
        timeframe: 'M15',
        time: Date.now() / 1000 - 3600,
        label: 'M15 OB'
      }
    ],
    fvgs: [
      // Only 5 Min FVGs (2 recent ones)
      {
        type: 'BULLISH',
        zoneType: 'FVG_BULLISH',
        top: currentPrice - 6,
        bottom: currentPrice + 6,
        timeframe: 'M5',
        time: Date.now() / 1000 - 900,
        label: 'M5 FVG'
      },
      {
        type: 'BEARISH',
        zoneType: 'FVG_BEARISH',
        top: currentPrice + 6,
        bottom: currentPrice - 6,
        timeframe: 'M5',
        time: Date.now() / 1000 - 1800,
        label: 'M5 FVG'
      }
    ],
    keyLevels: [
      // Only 1hr HH and LL (Higher High and Lower Low)
      {
        type: 'HIGHER_HIGH',
        zoneType: 'HH_H1',
        price: currentPrice + 35,
        timeframe: 'H1',
        time: Date.now() / 1000 - 7200,
        label: 'H1 HH'
      },
      {
        type: 'LOWER_LOW',
        zoneType: 'LL_H1',
        price: currentPrice - 40,
        timeframe: 'H1',
        time: Date.now() / 1000 - 7200,
        label: 'H1 LL'
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
