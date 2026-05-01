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
