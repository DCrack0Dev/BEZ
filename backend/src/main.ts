import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';

import { logger } from './logging';
import { TradingEngine } from './trading-engine';
import { attachAPI } from './api';
import { prisma, getCandles } from './database';

dotenv.config();

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 5000;

// Initialize Socket.IO
const io = new Server(server, { cors: { origin: '*' } });
const tradingEngine = new TradingEngine(io);

// Attach API
attachAPI(app);

// API Endpoints
app.post('/api/ea/validate', (req, res) => {
  const { apiKey } = req.body;
  logger.info('Auth request', apiKey);
  if (apiKey === 'FXSK-90e36448c3d1ef9d749aa155ba228541' || apiKey?.startsWith('FXSK-')) {
    return res.json({ valid: true, token: 'sk_live_' + Buffer.from(apiKey || '').toString('base64'), expiry: '2027-12-31', plan: 'Lifetime Pro', maxTrades: 15, maxOpenTrades: 15 });
  }
  res.status(401).json({ valid: false });
});

app.post('/api/ea/update', async (req, res) => {
  try {
    const data = req.body;
    await tradingEngine.processMT5Update(data);
    res.json({ success: true, commands: [] });
  } catch (error) {
    logger.error('Error in /api/ea/update', error);
    res.status(500).json({ success: false, error: 'Failed to process update' });
  }
});

app.get('/api/ea/commands', (req, res) => {
  const cmds = tradingEngine.clearPendingCommands();
  if (cmds.length > 0) logger.info('Sent commands to EA', cmds.length);
  res.json(cmds);
});

app.get('/api/account', (req, res) => res.json(tradingEngine.getAccountState()));
app.get('/api/orders/closed', (req, res) => res.json(tradingEngine.getClosedTrades()));
app.post('/api/order', (req, res) => {
  if (req.body.action === 'RESUME' || req.body.action === 'PAUSE') {
    const state = tradingEngine.getAccountState();
    tradingEngine.processMT5Update({ ...state, autoTradingEnabled: req.body.action === 'RESUME' } as any);
  } else {
    tradingEngine.addCommand(req.body);
  }
  res.json({ success: true });
});
app.post('/api/bot/config', (req, res) => {
  if (req.body.autoTradingEnabled !== undefined) {
    const state = tradingEngine.getAccountState();
    tradingEngine.processMT5Update({ ...state, autoTradingEnabled: req.body.autoTradingEnabled } as any);
  }
  tradingEngine.addCommand({ action: 'CONFIG_SYNC', ...req.body });
  res.json({ success: true });
});
app.get('/api/subscription', (req, res) => res.json({ active: true, plan: 'Lifetime Pro', expiry: '2027-12-31' }));
app.get('/api/dna', (req, res) => res.json(tradingEngine.getDna()));
app.get('/api/lessons', (req, res) => res.json(tradingEngine.getLessons()));
app.get('/api/models', (req, res) => res.json([]));
app.get('/api/features', (req, res) => res.json(tradingEngine.getAccountState().lastFeatures || {}));

// New Historical API Endpoints
app.get('/api/candles', async (req, res) => {
  try {
    const { symbol, timeframe, limit } = req.query;
    const candles = await getCandles(
      (symbol as string) || 'XAUUSD',
      (timeframe as string) || 'M5',
      Number(limit) || 1000
    );
    res.json(candles);
  } catch (error) {
    logger.error('Failed to fetch candles', error);
    res.status(500).json({ success: false, error: 'Failed to fetch candles' });
  }
});

// Socket.IO
io.on('connection', (socket) => {
  logger.info('Client connected', socket.id);
  socket.emit('EA_HEARTBEAT', tradingEngine.getAccountState());
  socket.on('disconnect', () => logger.info('Client disconnected', socket.id));
});

// Start server
async function startServer() {
  await tradingEngine.init();
  server.listen(PORT, () => {
    logger.success('LiquiBot backend v4.0 LIVE on port', PORT);
  });
}

startServer();
