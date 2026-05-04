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
    res.json({
      valid: true,
      token: 'mock-jwt-token-' + Date.now(),
      expiry: '2026-12-31',
      plan: 'PAID'
    });
  } else {
    res.status(401).json({ valid: false, message: 'Invalid API key' });
  }
});

// EA heartbeat endpoint - receives real data from EA
app.post('/api/ea/update', (req, res) => {
  console.log('[EA] Update received from EA');
  
  const { accountData, testStructures } = req.body;
  
  // Update account state with real EA data
  if (accountData) {
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
    
    // Store structures from EA
    if (testStructures) {
      accountState.structures = testStructures;
    }
    
    // Calculate real P&L from EA data (use EA's profit values)
    let totalProfit = 0;
    accountState.positions.forEach(pos => {
      if (pos.profit && typeof pos.profit === 'number') {
        totalProfit += pos.profit;
      }
    });
    accountState.profit = totalProfit;
    accountState.pnl_today = totalProfit;
    
    // Update equity properly (balance + floating P&L)
    accountState.equity = accountState.balance + totalProfit;
  }
  
  res.json({
    ea_connected: true,
    lastSeen: new Date().toISOString(),
    testStructures
  });
});

// Account endpoint - returns current account state
app.get('/api/account', (req, res) => {
  console.log('[ACCOUNT] Account data requested');
  
  // Return current account state with real EA data
  res.json(accountState);
});

// Order management endpoints
app.post('/api/order', (req, res) => {
  const { action, symbol, type, lots, sl, tp, ticket, apiKey } = req.body;
  
  console.log(`[ORDER] ${action} request for ${symbol} - Type: ${type} - Lots: ${lots}`);
  
  // Handle different order actions
  switch (action) {
    case 'BUY':
    case 'SELL':
      // Open a new position
      const newTicket = Math.floor(Math.random() * 1000000).toString();
      const newPosition = {
        ticket: newTicket,
        symbol: symbol || 'BTCUSD',
        type: action,
        volume: lots || 0.1,
        openPrice: accountState.price, // Use current price
        sl: sl || 0,
        tp: tp || 0,
        profit: 0,
        swap: 0,
        time: Date.now()
      };
      
      // Add to account state
      accountState.positions.push(newPosition);
      accountState.lastSeen = new Date().toISOString();
      
      console.log(`[ORDER] Opened ${action} position: ${newTicket}`);
      return res.json({
        success: true,
        ticket: newTicket,
        message: `${action} order placed successfully`,
        position: newPosition
      });
      
    case 'CLOSE_TRADE':
      // Close a specific position
      console.log(`[ORDER] Closing position: ${ticket}`);
      const positionIndex = accountState.positions.findIndex(pos => pos.ticket === ticket);
      
      if (positionIndex !== -1) {
        const closedPosition = accountState.positions[positionIndex];
        const profit = closedPosition.profit || (Math.random() * 200 - 100); // Use real profit if available
        
        // Remove from positions
        accountState.positions.splice(positionIndex, 1);
        
        // Update balance with profit/loss
        accountState.balance += profit;
        accountState.lastSeen = new Date().toISOString();
        
        console.log(`[ORDER] Closed position ${ticket} with profit: ${profit}`);
        return res.json({
          success: true,
          ticket: ticket,
          message: 'Position closed successfully',
          profit: profit
        });
      } else {
        return res.status(404).json({
          success: false,
          message: 'Position not found'
        });
      }
      
    case 'CLOSE_ALL':
      // Close all positions
      console.log(`[ORDER] Closing all positions for ${symbol}`);
      const positionsToClose = symbol 
        ? accountState.positions.filter(pos => pos.symbol === symbol)
        : [...accountState.positions];
      
      let totalProfit = 0;
      positionsToClose.forEach(pos => {
        totalProfit += pos.profit || (Math.random() * 200 - 100);
      });
      
      // Remove closed positions
      if (symbol) {
        accountState.positions = accountState.positions.filter(pos => pos.symbol !== symbol);
      } else {
        accountState.positions = [];
      }
      
      // Update balance
      accountState.balance += totalProfit;
      accountState.lastSeen = new Date().toISOString();
      
      return res.json({
        success: true,
        message: 'All positions closed',
        totalProfit: totalProfit
      });
      
    default:
      return res.status(400).json({
        success: false,
        message: 'Invalid order action'
      });
  }
});

// Closed orders endpoint
app.get('/api/orders/closed', (req, res) => {
  res.json([]);
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Initial Account State: Balance: R${accountState.balance}, Equity: R${accountState.equity}, Positions: ${accountState.positions.length}`);
});
