const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(bodyParser.json());

// In-memory database
const db = {
  users: [],
  apiKeys: [
    { key: 'FXSK-DEFAULT-KEY-2025', type: 'PAID', lastUsed: null, accountId: null }
  ],
  accountStates: {},
  pendingCommands: {},
  tradeHistory: []
};

// --- Helper Functions ---
const generateKey = () => `FXSK-${require('crypto').randomBytes(16).toString('hex')}`;

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

// --- BASE ENDPOINT ---
app.get('/', (req, res) => {
  res.send('FxScalpKing Backend is Running Successfully!');
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
  const { apiKey, accountData, positions } = req.body;

  const keyEntry = findApiKey(apiKey);
  if (!keyEntry) {
    return res.status(401).json({ error: 'Invalid API Key' });
  }

  // Update account state
  db.accountStates[apiKey] = {
    ...accountData,
    positions: positions || [],
    lastSeen: new Date().toISOString()
  };

  // Get pending commands for this EA
  const commands = db.pendingCommands[apiKey] || [];
  db.pendingCommands[apiKey] = [];

  res.json({
    success: true,
    commands: commands,
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

  // Store trade in history
  db.tradeHistory.push({
    ...trade,
    apiKey,
    executedAt: new Date().toISOString()
  });

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
  const state = db.accountStates[apiKey];

  if (!state) {
    return res.json({
      balance: 0,
      equity: 0,
      pnl_today: 0,
      ea_connected: false,
      positions: [],
      message: 'EA not connected'
    });
  }

  const isConnected = (new Date() - new Date(state.lastSeen)) < 10000;

  res.json({
    balance: state.balance,
    equity: state.equity,
    pnl_today: state.pnl_today,
    ea_connected: isConnected,
    positions: state.positions,
    ea_symbol: state.eaSymbol || 'XAUUSD'
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

  const trades = db.tradeHistory
    .filter(t => t.apiKey === apiKey && new Date(t.executedAt) >= startDate)
    .map(t => ({
      id: t.trade?.ticket || Date.now(),
      symbol: t.trade?.symbol || 'XAUUSD',
      type: t.trade?.type === 'BUY' ? 'BUY' : 'SELL',
      pips: t.trade?.pips || 0,
      profit: t.trade?.profit || 0,
      date: t.executedAt
    }));

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
  const { apiKey, action, symbol, type, lots, sl, tp } = req.body;

  if (!db.pendingCommands[apiKey]) {
    db.pendingCommands[apiKey] = [];
  }

  const command = {
    id: Date.now(),
    action,
    symbol,
    type,
    lots,
    sl,
    tp,
    createdAt: new Date().toISOString()
  };

  db.pendingCommands[apiKey].push(command);

  res.json({
    success: true,
    message: 'Command queued for EA',
    commandId: command.id
  });
});

// Get signal (for mobile app chart)
app.get('/api/signal', (req, res) => {
  const { symbol, tf } = req.query;
  
  // Return mock signal for now
  res.json({
    symbol: symbol || 'XAUUSD',
    tf: tf || 'M5',
    signal: Math.random() > 0.5 ? 'BUY' : 'SELL'
  });
});

app.listen(PORT, () => {
  console.log(`FxScalpKing Backend running on http://localhost:${PORT}`);
  console.log(`EA Endpoints ready for MT5 connection`);
});
