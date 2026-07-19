/**
 * tradingConfig.ts
 * Central configuration for the FxScalpKing Trading Robot.
 * Contains all parameters for risk management, entry filters, and execution logic.
 */

export const CONFIG = {
  // Risk
  riskPercentPerTrade: 1.0,       // % of account per trade (long). Use 0.75 for XAUUSD short.
  maxDrawdownPercent: 5.0,
  maxOpenTrades: 3,               // per symbol (use 2 for XAUUSD)

  // Entry filters
  reversalCandleCount: 10,        // swing low/high lookback
  minCandleBodyPips: 3,           // long forex minimum body
  minCandleBodyPoints: 50,        // short XAUUSD minimum body (50 points)
  volumeMultiplier: 1.5,
  maxSpreadPips: 2.0,             // forex
  maxSpreadPoints: 30,            // XAUUSD (30 points for Deriv)
  spreadBuffer: 30,               // Deriv Gold buffer (30 points)
  supportProximityPips: 10,       // long: how close to support
  resistanceProximityPoints: 100, // short XAUUSD: how close to resistance

  // ATR stop (XAUUSD short preferred)
  useAtrStop: true,
  atrMultiplier: 1.2,             // Deriv Gold (1.2 multiplier)

  // Take profit R:R
  tp1RR: 1.5,
  tp2RR: 3.0,
  // TP3 = prior resistance (long) or prior swing low (short) — passed from MT5

  // Trailing stop
  trailDistanceMultiplier: 0.75,
  trailPhase3Multiplier: 0.5,     // use 0.3 for XAUUSD short
  
  // Scale-in ratios
  scaleIn2PositionRatio: 0.40,
  scaleIn3PositionRatio: 0.55,

  // Signal expiry
  signalExpirySeconds: 30,        // use 20 for XAUUSD short

  // News filter (short XAUUSD only)
  blockMinutesBeforeNews: 15,
  blockMinutesAfterNews: 10,

  // MT5
  mt5PushUrl: "https://liquibot-back.onrender.com", // Updated to match environment
  commandPollIntervalMs: 500,
};
