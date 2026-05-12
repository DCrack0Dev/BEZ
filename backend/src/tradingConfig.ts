/**
 * tradingConfig.ts
 * Central configuration for the FxScalpKing Trading Robot.
 * Contains all parameters for risk management, entry filters, and execution logic.
 */

export const CONFIG = {
  // --- AGGRESSIVE SCALPING PARAMETERS ---
  timeframe: 'M1',                // Primary scalping timeframe
  takeProfitPips: 10,             // 5-15 pips target
  stopLossPips: 5,                // 3-8 pips tight risk
  trailStopPips: 3,               // Lock profits early
  partialClosePercent: 0.50,      // Close 50% at 5 pips
  
  // --- Risk Management ---
  riskPercentPerTrade: 1.5,       // Aggressive 1-2% risk
  maxDrawdownPercent: 12.0,       // 10-15% daily limit
  dailyProfitTarget: 3.0,         // 2-5% target
  maxOpenTrades: 8,               // 5-10 simultaneous positions
  maxDailyTrades: 75,             // 50-100 trades limit
  accountCurrency: 'USD',

  // --- Fast Indicators ---
  fastEMA: 5,
  midEMA: 10,
  slowEMA: 20,
  rsiPeriod: 7,                   // Fast RSI (7 or 9)
  stochK: 5,
  stochD: 3,
  stochSlowing: 3,
  bbPeriod: 10,                   // Scalping BB (10, 2)
  bbDev: 2.0,

  // --- Entry Filters ---
  reversalCandleCount: 5,         // Faster lookback
  minCandleBodyPips: 1.5,         // Lower noise threshold for M1
  volumeMultiplier: 1.2,          // More sensitive volume confirmation
  maxSpreadPips: 2.0,             // Kept same as per user instruction
  supportProximityPips: 5.0,      // Tighter proximity for scalping

  // --- Session Filters ---
  tradeLondon: true,
  tradeNewYork: true,
  tradeAsia: false,
  blockNewsMinutes: 15,

  // --- Take Profit R:R (Scalping) ---
  tp1RR: 1.0,                     // TP1 at 1R for fast banking
  tp2RR: 2.0,                     // TP2 at 2R

  // --- System Settings ---
  signalExpirySeconds: 15,        // M1 signals expire very fast
  mt5PushUrl: "https://liquibot-back.onrender.com",
  commandPollIntervalMs: 250,     // Faster polling for scalping
};
