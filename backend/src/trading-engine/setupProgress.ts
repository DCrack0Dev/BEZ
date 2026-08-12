import { CONFIG } from '../config/tradingConfig';
import { Candle, MT5Payload } from '../types';
import {
  calculateATR,
  calculateSwingHighs,
  calculateSwingLows,
  getCurrentSession,
} from './signalValidator';

/**
 * Live entry-setup scoreboard — mirrors validateSignal() gates without
 * emitting a trade. Shown on every EA heartbeat so the mobile Terminal
 * can explain what the bot wants and how close each requirement is.
 */

export interface SetupRequirement {
  id: string;
  label: string;
  /** Human-readable expected vs actual, e.g. "spread ≤ 30 pts (now 12)" */
  detail: string;
  expected: string;
  actual: string;
  met: boolean;
  /** 0–100 closeness for soft metrics (spread, ATR, proximity) */
  progress: number;
}

export interface SetupProgress {
  updatedAt: number;
  session: string;
  timezoneTradingEnabled: boolean;
  trend: string;
  bias: 'BUY' | 'SELL' | 'NONE';
  tradeType: 'BUY' | 'SELL' | 'WAITING';
  overallProgress: number;
  summary: string;
  hardGates: SetupRequirement[];
  buyGates: SetupRequirement[];
  sellGates: SetupRequirement[];
  blockers: string[];
}

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n));
}

function fmt(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

function req(
  id: string,
  label: string,
  met: boolean,
  expected: string,
  actual: string,
  progress?: number
): SetupRequirement {
  return {
    id,
    label,
    met,
    expected,
    actual,
    detail: `${expected} · now ${actual}`,
    progress: progress !== undefined ? clamp(progress) : met ? 100 : 0,
  };
}

function trendFromEma(price: number, ema20: number, ema20Prev: number, ema50: number): string {
  if (price > ema20 && ema20 > ema50 && ema20 >= ema20Prev) return 'BULLISH';
  if (price < ema20 && ema20 < ema50 && ema20 <= ema20Prev) return 'BEARISH';
  if (price > ema20) return 'BULLISH_WEAK';
  if (price < ema20) return 'BEARISH_WEAK';
  return 'RANGE';
}

/**
 * Evaluate how close the market is to a valid BUY or SELL entry.
 * `timezoneTradingEnabled=true` enforces CONFIG.blockedSessions (Asia by default).
 * `timezoneTradingEnabled=false` allows any session when other conditions pass.
 */
export function evaluateSetupProgress(
  payload: MT5Payload,
  opts: { timezoneTradingEnabled?: boolean; autoTradingEnabled?: boolean } = {}
): SetupProgress {
  const timezoneTradingEnabled = opts.timezoneTradingEnabled !== false;
  const session = getCurrentSession();
  const {
    symbol,
    candles,
    spread,
    balance,
    equity,
    pipSize,
    pointSize,
    ema20,
    ema20Prev,
    openPositionsCount,
    newsFilterActive,
  } = payload;

  const empty: SetupProgress = {
    updatedAt: Date.now(),
    session,
    timezoneTradingEnabled,
    trend: 'UNKNOWN',
    bias: 'NONE',
    tradeType: 'WAITING',
    overallProgress: 0,
    summary: 'Waiting for market data…',
    hardGates: [],
    buyGates: [],
    sellGates: [],
    blockers: ['Need candle history from EA heartbeat'],
  };

  const N = CONFIG.reversalCandleCount;
  if (!candles || candles.length < N + 1) return empty;

  const atr14 = payload.atr14 !== undefined ? payload.atr14 : calculateATR(candles, 14);
  const swingHighs = payload.swingHighs !== undefined ? payload.swingHighs : calculateSwingHighs(candles);
  const swingLows = payload.swingLows !== undefined ? payload.swingLows : calculateSwingLows(candles);
  const ema50 = calculateEMA50(candles);

  const currentCandle = candles[candles.length - 1];
  const priorCandle = candles[candles.length - 2];
  const price = currentCandle.close;
  const isXAUUSD = symbol.includes('XAU') || symbol.includes('GOLD');

  const drawdown = balance > 0 ? ((balance - equity) / balance) * 100 : 0;
  const maxOpen = isXAUUSD ? 2 : CONFIG.maxOpenTrades;
  const maxSpread = isXAUUSD ? CONFIG.maxSpreadPoints * pointSize : CONFIG.maxSpreadPips * pipSize;
  const maxSpreadDisplay = isXAUUSD ? CONFIG.maxSpreadPoints : CONFIG.maxSpreadPips;
  const spreadActual = isXAUUSD ? spread / (pointSize || 1) : spread / (pipSize || 1);

  const sessionBlocked =
    timezoneTradingEnabled && CONFIG.blockedSessions.includes(session);

  const hardGates: SetupRequirement[] = [
    req(
      'candles',
      'Candle history',
      candles.length >= N + 1,
      `≥ ${N + 1} bars`,
      `${candles.length} bars`,
      (candles.length / (N + 1)) * 100
    ),
    req(
      'drawdown',
      'Drawdown',
      drawdown <= CONFIG.maxDrawdownPercent,
      `≤ ${CONFIG.maxDrawdownPercent}%`,
      `${fmt(drawdown, 2)}%`,
      clamp(100 - (drawdown / CONFIG.maxDrawdownPercent) * 100)
    ),
    req(
      'openTrades',
      'Open trades',
      openPositionsCount < maxOpen,
      `< ${maxOpen}`,
      `${openPositionsCount}`,
      openPositionsCount < maxOpen ? 100 : 0
    ),
    req(
      'spread',
      'Spread',
      spread <= maxSpread,
      `≤ ${maxSpreadDisplay} ${isXAUUSD ? 'pts' : 'pips'}`,
      `${fmt(spreadActual, 1)} ${isXAUUSD ? 'pts' : 'pips'}`,
      clamp(100 - (spreadActual / maxSpreadDisplay) * 100)
    ),
    req(
      'session',
      'Session / timezone',
      !sessionBlocked,
      timezoneTradingEnabled
        ? `Not in blocked (${CONFIG.blockedSessions.join(',')})`
        : 'Any time (timezone filter OFF)',
      `${session}${sessionBlocked ? ' BLOCKED' : ''}`,
      sessionBlocked ? 0 : 100
    ),
  ];

  if (payload.marginLevel !== undefined) {
    hardGates.push(
      req(
        'margin',
        'Margin level',
        payload.marginLevel >= CONFIG.minMarginLevelPercent,
        `≥ ${CONFIG.minMarginLevelPercent}%`,
        `${fmt(payload.marginLevel, 0)}%`,
        clamp((payload.marginLevel / CONFIG.minMarginLevelPercent) * 100)
      )
    );
  }

  if (payload.dailyLossPercent !== undefined) {
    hardGates.push(
      req(
        'dailyLoss',
        'Daily loss',
        payload.dailyLossPercent < CONFIG.maxDailyLossPercent,
        `< ${CONFIG.maxDailyLossPercent}%`,
        `${fmt(payload.dailyLossPercent, 2)}%`,
        clamp(100 - (payload.dailyLossPercent / CONFIG.maxDailyLossPercent) * 100)
      )
    );
  }

  hardGates.push(
    req(
      'news',
      'News filter',
      !newsFilterActive,
      'Clear of news block',
      newsFilterActive ? 'BLOCKED' : 'Clear',
      newsFilterActive ? 0 : 100
    )
  );

  // --- BUY pattern ---
  const isBullish = currentCandle.close > currentCandle.open;
  const lookbackLows = candles.slice(-(N + 1), -1).map((c: Candle) => c.low);
  const isLowestLow = priorCandle.low === Math.min(...lookbackLows);
  const closesAboveMidpoint = currentCandle.close > (priorCandle.open + priorCandle.close) / 2;
  const isEngulfingBull = currentCandle.close > priorCandle.high && currentCandle.open < priorCandle.low;
  const bodySizePips = Math.abs(currentCandle.close - currentCandle.open) / (pipSize || 1);
  const isBodyLargeEnoughLong = bodySizePips >= CONFIG.minCandleBodyPips;
  const avgVolume = candles.slice(-20).reduce((acc: number, c: Candle) => acc + c.volume, 0) / Math.max(1, Math.min(20, candles.length));
  const volTarget = avgVolume * CONFIG.volumeMultiplier;
  const isVolumeSpike = currentCandle.volume >= volTarget;
  const supportCandidates = swingLows.filter((l: number) => l <= price);
  const nearestSupport = supportCandidates.length ? Math.max(...supportCandidates) : NaN;
  const supportDistPips = Number.isFinite(nearestSupport)
    ? (price - nearestSupport) / (pipSize || 1)
    : Infinity;
  const isNearSupport = supportDistPips <= CONFIG.supportProximityPips;
  const buyReversal = closesAboveMidpoint || isEngulfingBull;

  // ATR context for shorts (expected stop cushion) — user asked for expected vs actual ATR
  const atrStopBuffer = atr14 * CONFIG.atrMultiplier;
  const atrExpectedPts = isXAUUSD ? atr14 / (pointSize || 1) : atr14 / (pipSize || 1);

  const buyGates: SetupRequirement[] = [
    req('buy_candle', 'Bullish candle', isBullish, 'Close > Open', isBullish ? 'Bullish' : 'Bearish'),
    req('buy_swing', 'Swing low base', isLowestLow, 'Prior bar = lowest of lookback', isLowestLow ? 'Yes' : 'No'),
    req(
      'buy_reversal',
      'Reversal / engulf',
      buyReversal,
      'Close above mid or bullish engulf',
      buyReversal ? (isEngulfingBull ? 'Engulfing' : 'Above mid') : 'Waiting'
    ),
    req(
      'buy_body',
      'Candle body',
      isBodyLargeEnoughLong,
      `≥ ${CONFIG.minCandleBodyPips} pips`,
      `${fmt(bodySizePips, 1)} pips`,
      clamp((bodySizePips / CONFIG.minCandleBodyPips) * 100)
    ),
    req(
      'buy_volume',
      'Volume spike',
      isVolumeSpike,
      `≥ ${CONFIG.volumeMultiplier}× avg (${fmt(volTarget, 0)})`,
      `${fmt(currentCandle.volume, 0)}`,
      clamp((currentCandle.volume / Math.max(1, volTarget)) * 100)
    ),
    req(
      'buy_support',
      'Near support',
      isNearSupport,
      `≤ ${CONFIG.supportProximityPips} pips from swing low`,
      Number.isFinite(supportDistPips) ? `${fmt(supportDistPips, 1)} pips` : 'No swing low',
      Number.isFinite(supportDistPips)
        ? clamp(100 - (supportDistPips / CONFIG.supportProximityPips) * 100)
        : 0
    ),
  ];

  // --- SELL pattern ---
  const isBearish = currentCandle.close < currentCandle.open;
  const lookbackHighs = candles.slice(-(N + 1), -1).map((c: Candle) => c.high);
  const isHighestHigh = priorCandle.high === Math.max(...lookbackHighs);
  const isBelowEma = price < ema20;
  const isEmaSlopingDown = ema20 < ema20Prev;
  const closesBelowMidpoint = currentCandle.close < (priorCandle.open + priorCandle.close) / 2;
  const isEngulfingBear = currentCandle.close < priorCandle.low && currentCandle.open > priorCandle.high;
  const upperWick = currentCandle.high - Math.max(currentCandle.open, currentCandle.close);
  const candleBody = Math.abs(currentCandle.close - currentCandle.open);
  const isShootingStar = upperWick >= 2 * candleBody;
  const bodySizePoints = candleBody / (pointSize || 1);
  const isBodyLargeEnoughShort = isXAUUSD
    ? bodySizePoints >= CONFIG.minCandleBodyPoints
    : bodySizePips >= CONFIG.minCandleBodyPips;
  const bodyExpectedShort = isXAUUSD
    ? `${CONFIG.minCandleBodyPoints} pts`
    : `${CONFIG.minCandleBodyPips} pips`;
  const bodyActualShort = isXAUUSD ? `${fmt(bodySizePoints, 1)} pts` : `${fmt(bodySizePips, 1)} pips`;
  const resistCandidates = swingHighs.filter((h: number) => h >= price);
  const nearestResistance = resistCandidates.length ? Math.min(...resistCandidates) : NaN;
  const resistDist = Number.isFinite(nearestResistance)
    ? isXAUUSD
      ? (nearestResistance - price) / (pointSize || 1)
      : (nearestResistance - price) / (pipSize || 1)
    : Infinity;
  const resistLimit = isXAUUSD ? CONFIG.resistanceProximityPoints : CONFIG.supportProximityPips;
  const isNearResistance = resistDist <= resistLimit;
  const sellReversal = closesBelowMidpoint || isEngulfingBear || isShootingStar;

  const sellGates: SetupRequirement[] = [
    req('sell_candle', 'Bearish candle', isBearish, 'Close < Open', isBearish ? 'Bearish' : 'Bullish'),
    req('sell_swing', 'Swing high base', isHighestHigh, 'Prior bar = highest of lookback', isHighestHigh ? 'Yes' : 'No'),
    req('sell_ema', 'Price below EMA20', isBelowEma, `Price < EMA20 (${fmt(ema20)})`, fmt(price)),
    req(
      'sell_ema_slope',
      'EMA20 sloping down',
      isEmaSlopingDown,
      'EMA20 < EMA20 prev',
      `${fmt(ema20)} vs ${fmt(ema20Prev)}`
    ),
    req(
      'sell_reversal',
      'Reversal / star / engulf',
      sellReversal,
      'Below mid, engulf, or shooting star',
      sellReversal ? 'Yes' : 'Waiting'
    ),
    req(
      'sell_body',
      'Candle body',
      isBodyLargeEnoughShort,
      `≥ ${bodyExpectedShort}`,
      bodyActualShort,
      isXAUUSD
        ? clamp((bodySizePoints / CONFIG.minCandleBodyPoints) * 100)
        : clamp((bodySizePips / CONFIG.minCandleBodyPips) * 100)
    ),
    req(
      'sell_volume',
      'Volume spike',
      isVolumeSpike,
      `≥ ${CONFIG.volumeMultiplier}× avg (${fmt(volTarget, 0)})`,
      `${fmt(currentCandle.volume, 0)}`,
      clamp((currentCandle.volume / Math.max(1, volTarget)) * 100)
    ),
    req(
      'sell_resist',
      'Near resistance',
      isNearResistance,
      `≤ ${resistLimit} ${isXAUUSD ? 'pts' : 'pips'} from swing high`,
      Number.isFinite(resistDist) ? `${fmt(resistDist, 1)}` : 'No swing high',
      Number.isFinite(resistDist) ? clamp(100 - (resistDist / resistLimit) * 100) : 0
    ),
    req(
      'sell_atr',
      'ATR (stop cushion)',
      atr14 > 0,
      `ATR14×${CONFIG.atrMultiplier} for SL`,
      `ATR ${fmt(atrExpectedPts, 1)} ${isXAUUSD ? 'pts' : 'pips'} (buffer ${fmt(atrStopBuffer / (isXAUUSD ? pointSize || 1 : pipSize || 1), 1)})`,
      atr14 > 0 ? 100 : 0
    ),
  ];

  const hardMet = hardGates.filter((g) => g.met).length;
  const buyMet = buyGates.filter((g) => g.met).length;
  const sellMet = sellGates.filter((g) => g.met).length;
  const hardOk = hardGates.every((g) => g.met);

  const buyScore = hardOk
    ? (hardMet / hardGates.length) * 40 + (buyMet / buyGates.length) * 60
    : (hardMet / hardGates.length) * 40 + (buyMet / buyGates.length) * 20;
  const sellScore = hardOk
    ? (hardMet / hardGates.length) * 40 + (sellMet / sellGates.length) * 60
    : (hardMet / hardGates.length) * 40 + (sellMet / sellGates.length) * 20;

  const buyReady = hardOk && buyGates.every((g) => g.met);
  const sellReady = hardOk && sellGates.every((g) => g.met);

  let bias: 'BUY' | 'SELL' | 'NONE' = 'NONE';
  let tradeType: 'BUY' | 'SELL' | 'WAITING' = 'WAITING';
  let overallProgress = Math.max(buyScore, sellScore);

  if (buyReady) {
    bias = 'BUY';
    tradeType = 'BUY';
    overallProgress = 100;
  } else if (sellReady) {
    bias = 'SELL';
    tradeType = 'SELL';
    overallProgress = 100;
  } else if (buyScore >= sellScore) {
    bias = 'BUY';
  } else {
    bias = 'SELL';
  }

  const trend = trendFromEma(price, ema20, ema20Prev || ema20, ema50);
  const activeGates = bias === 'SELL' ? sellGates : buyGates;
  const missing = [...hardGates, ...activeGates].filter((g) => !g.met).map((g) => g.label);
  const blockers = missing.slice(0, 6);

  let summary: string;
  if (buyReady || sellReady) {
    summary = `READY ${tradeType} · ${trend} · ${session} · ATR ${fmt(atrExpectedPts, 1)}`;
  } else if (!opts.autoTradingEnabled) {
    summary = `Auto-trade OFF · Looking ${bias} (${fmt(overallProgress, 0)}%) · ${trend} · ${session}`;
  } else {
    summary = `Looking ${bias} · ${fmt(overallProgress, 0)}% · ${trend} · ${session} · need: ${blockers[0] || 'confirm'}`;
  }

  return {
    updatedAt: Date.now(),
    session,
    timezoneTradingEnabled,
    trend,
    bias,
    tradeType,
    overallProgress: clamp(overallProgress),
    summary,
    hardGates,
    buyGates,
    sellGates,
    blockers,
  };
}

function calculateEMA50(candles: Candle[]): number {
  const period = 50;
  if (candles.length < period) return candles[candles.length - 1]?.close || 0;
  const k = 2 / (period + 1);
  let ema = candles.slice(0, period).reduce((a, c) => a + c.close, 0) / period;
  for (let i = period; i < candles.length; i++) {
    ema = candles[i].close * k + ema * (1 - k);
  }
  return ema;
}
