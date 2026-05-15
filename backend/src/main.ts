import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { Server } from 'socket.io';
import http from 'http';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// Initialize WebSocket
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

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
let closedTrades: any[] = [];

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

/**
 * EA Update (Heartbeat Relay)
 * The backend acts ONLY as a relay. It receives data from EA and pushes it to App via WS.
 */
app.post('/api/ea/update', (req, res) => {
  const data = req.body;
  
  if (!data.symbol) {
    return res.status(400).json({ error: 'Missing symbol' });
  }

  // Handle Closed Trades Sync
  if (data.closedTrades && Array.isArray(data.closedTrades)) {
    data.closedTrades.forEach((t: any) => {
      if (!closedTrades.find(existing => existing.ticket === t.ticket)) {
        closedTrades.unshift(t);
        log(`💰 Closed Trade Recorded: #${t.ticket} | Profit: ${t.profit}`);
      }
    });
    // Keep only last 100 closed trades in memory
    if (closedTrades.length > 100) closedTrades = closedTrades.slice(0, 100);
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

  log(`💓 Heartbeat Relay: ${data.symbol} | Price: ${data.price} | Positions: ${accountState.positions.length}`);

  // Push raw EA data to App Brain for analysis
  io.emit('EA_HEARTBEAT', accountState);

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

// App Closed Trades (Relay or Local Store)
app.get('/api/orders/closed', (req, res) => {
  res.json(closedTrades);
});

// App Order Relay (Execution Brain -> EA)
app.post('/api/order', (req, res) => {
  log(`📥 App Order Relay: ${req.body.action} ${req.body.symbol}`);
  pendingCommands.push(req.body);
  res.json({ success: true });
});

// Bot Config Sync
app.post('/api/bot/config', (req, res) => {
  log(`⚙️ Bot Config Sync: ${JSON.stringify(req.body)}`);
  pendingCommands.push({ action: 'CONFIG_SYNC', ...req.body });
  res.json({ success: true });
});

server.listen(PORT, () => {
  log(`🚀 Backend Relay v2.13 Live on port ${PORT}`);
});
