/**
 * xauusdConfig.ts
 * Specific configuration for Gold (XAUUSD) SHORT entries.
 * Handles tighter risk and gold-specific volatility parameters.
 */

export const XAUUSD_CONFIG = {
  symbol: "XAUUSD",

  // --- Risk Management (Tighter for Gold) ---
  /** % of account balance total risk per trade (0.75% due to gold volatility) */
  riskPercentPerTrade: 0.75,
  /** Maximum allowed drawdown for gold trading */
  maxDrawdownPercent: 4.0,
  /** Maximum simultaneous open trades on XAUUSD */
  maxOpenTrades: 2,

  // --- Entry Filters (Short specific) ---
  /** Look back period for swing high (rally exhaustion) */
  reversalCandleCount: 10,
  /** Minimum candle body in points (50 points = 5 pips equivalent) */
  minCandleBodyPoints: 50,
  /** Volume surge multiplier to confirm distribution */
  volumeMultiplier: 1.5,
  /** Max allowed spread in points (XAUUSD: 35 points / 3.5 pips) */
  maxSpreadPoints: 35,
  /** Proximity to horizontal resistance in points */
  resistanceProximityPoints: 100,

  // --- ATR-Based Dynamic Stop ---
  /** Use ATR for stop loss calculation instead of fixed points */
  useAtrStop: true,
  /** ATR(14) multiplier for SL distance */
  atrMultiplier: 1.0,

  // --- Take Profit & R:R ---
  /** TP1 Target (Risk:Reward Ratio) */
  tp1RR: 1.5,
  /** TP2 Target (Risk:Reward Ratio) */
  tp2RR: 3.0,
  /** Note: TP3 targets the next major swing low from MT5 */

  // --- Trailing Stop (Short specific - moving down) ---
  /** Trail distance as multiplier of original SL points */
  trailDistanceMultiplier: 0.75,
  /** Tightened trail for Phase 3 (gold reverses sharp) */
  trailPhase3Multiplier: 0.3,

  // --- Scale-In Positioning ---
  /** Trigger at 40% of the way to TP1 */
  scaleIn2PositionRatio: 0.40,
  /** Trigger at 55% of the way to TP2 */
  scaleIn3PositionRatio: 0.55,

  // --- Signal & News ---
  /** Signal validity duration (gold moves fast) */
  signalExpirySeconds: 20,
  /** News filter: minutes before high-impact events */
  blockTradesMinutesBeforeNews: 15,
  /** News filter: minutes after high-impact events */
  blockTradesMinutesAfterNews: 10,

  // --- XAUUSD Constants ---
  /** Broker point size for gold (usually 0.01) */
  pointSize: 0.01,
};
