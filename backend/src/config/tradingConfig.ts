/**
 * tradingConfig.ts
 * Central configuration for the FxScalpKing Trading Robot.
 * Contains all parameters for risk management, entry filters, and execution logic.
 * AI_* values are loaded from process.env so .env / Render env vars take effect.
 */

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function envNum(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const CONFIG = {
  // Risk
  riskPercentPerTrade: 1.0,       // % of account per trade (long). Use 0.75 for XAUUSD short.
  maxDrawdownPercent: 5.0,
  maxDailyLossPercent: 3.0,       // Max daily loss percentage
  maxOpenTrades: 3,               // per symbol (use 2 for XAUUSD)
  minRiskRewardRatio: 1.2,        // Minimum required R/R to take trade
  minMarginLevelPercent: 200,      // Reject new trades if marginLevel% falls below this (when reported)

  // Entry filters
  reversalCandleCount: 10,        // swing low/high lookback
  minCandleBodyPips: 3,           // long forex minimum body
  minCandleBodyPoints: 50,        // short XAUUSD minimum body (50 points)
  volumeMultiplier: 1.5,
  maxSpreadPips: 2.0,             // forex
  maxSpreadPoints: 800,           // XAUUSD default (points); adjustable via bot config / settings
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

  // Blocked sessions
  blockedSessions: ["ASIA"],      // Sessions to block

  // MT5
  mt5PushUrl: "https://liquibot-back.onrender.com", // Updated to match environment
  commandPollIntervalMs: 500,

  // --- AI / Confidence Engine ---
  // Master switch: when false (default), the neural network still runs and
  // every prediction is logged (shadow mode) so it can be compared against
  // the rule engine's actual outcomes, but it NEVER gates or blocks a trade.
  // Flip AI_TRADING_ENABLED=true only after reviewing enough shadow-mode
  // PredictionLog history to trust the model's live behavior.
  aiTradingEnabled: envBool('AI_TRADING_ENABLED', false),
  // Minimum combined (rule + AI) confidence required to accept a signal
  // once aiTradingEnabled is true.
  aiMinConfidence: envNum('AI_MIN_CONFIDENCE', 0.6),
  // If the AI's predicted action actively contradicts the rule engine's
  // direction (e.g. rule says BUY, AI says SELL) with at least this much
  // confidence, reject the trade even if the combined score would otherwise
  // pass — a strong disagreement is treated as a hard veto, not just a
  // confidence penalty.
  aiContradictionVetoThreshold: envNum('AI_CONTRADICTION_VETO_THRESHOLD', 0.55),
};
