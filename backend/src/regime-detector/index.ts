/**
 * Market Regime Detector
 *
 * Classifies the current market into one of 6 regimes using a score-based
 * rule-blended classifier (no neural weights required in Phase 1). The same
 * inputs that already exist in the feature pipeline (ADX, ATR ratio, BB
 * width, candle body/volume spreads, session) are used so this produces
 * meaningful output on *every* MT5 heartbeat with zero extra dependencies.
 *
 * A neural regime classifier (trained on labeled price-action segments)
 * can be added later without changing the public interface — just plug it
 * in as a second voter inside `classify()` and renormalize scores.
 *
 * Strategies gated per regime:
 *   TRENDING      → trend-continuation, pullback entries, wider TP
 *   RANGING       → fade extremes, tight TP near SR, avoid pyramiding
 *   VOLATILE      → widen SL, skip low-confidence entries, trade only LDN/NY
 *   NEWS_DRIVEN   → avoid all entries until 15min post-event unless specific
 *                   liquidity-sweep + OB confluence (never default-block:
 *                   caller decides via `hardGate` flag).
 *   LOW_LIQUIDITY → ASIA-only. Smaller lots, avoid breakouts (fakeouts likely)
 *   HIGH_LIQUIDITY → LDN/NY overlap. Full strategy set permitted.
 */

import { MarketRegime, MarketRegimeClassification, SpreadStatus, Volatility, MarketSession } from '../types';

export interface RegimeInputs {
  /** Average Directional Index (0-100). ADX > 25 = trending. */
  adxValue: number;
  /** Current ATR / 20-bar avg ATR. 1.0 = normal. */
  atrRatio: number;
  /** Bollinger %B position or BB width ratio vs 50-bar average (0.5 = normal, >1.3 = expanded). */
  bbWidthRatio?: number;
  /** Last N candles: fraction of bodies vs range (low = long wicks = ranging/shakeout). */
  recentCandleBodyPctAvg?: number;
  /** High-to-low range on last 3 bars / high-to-low on prior 3 bars (>1.5 = expansion). */
  rangeExpansionRatio?: number;
  /** Spread status. */
  spreadStatus: SpreadStatus;
  /** Volatility bucket from features. */
  volatility: Volatility;
  /** Market session (for liquidity heuristics). */
  marketSession: MarketSession;
  /** Any high-impact news within ±15 minutes of now. */
  nearbyHighImpactNews?: boolean;
  /** Tick volume / 20-bar average tick volume. */
  volumeRatio?: number;
  /** EMA20 distance from EMA50 divided by ATR. Larger = stronger directional regime. */
  emaGapAtrRatio?: number;
  /** RSI distance from 50. Closer to 50 = more range-y. */
  rsiDeviationFrom50?: number;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
}

function softArgMax(scores: Record<MarketRegime, number>): {
  regime: MarketRegime;
  confidence: number;
} {
  const entries = Object.entries(scores) as Array<[MarketRegime, number]>;
  entries.sort((a, b) => b[1] - a[1]);
  const [best, bestScore] = entries[0];
  const [, secondScore] = entries[1];
  const total = entries.reduce((s, [, v]) => s + v, 0) || 1;
  const margin = bestScore - secondScore;
  const confidence = clamp01((bestScore / total) + margin * 0.5);
  return { regime: best, confidence };
}

function compatibleFor(regime: MarketRegime): string[] {
  switch (regime) {
    case 'TRENDING':
      return ['ALL', 'BUY_RULES', 'SELL_RULES', 'TREND_FOLLOWING', 'PYRAMIDING_ALLOWED', 'MULTI_TP'];
    case 'RANGING':
      return ['RANGING_ONLY', 'SUPPORT_RESISTANCE_FADES', 'NO_PYRAMIDING'];
    case 'VOLATILE':
      return ['VOL_SAFE', 'LARGE_SL', 'NO_SCALPING', 'LONDON_ONLY', 'NEWYORK_ONLY'];
    case 'NEWS_DRIVEN':
      return ['NEWS_SAFE', 'SWEEP_ONLY', 'OB_CONFLUENCE_REQUIRED', 'NO_PYRAMIDING'];
    case 'LOW_LIQUIDITY':
      return ['LOW_LIQ_SAFE', 'SMALL_LOTS', 'NO_BREAKOUTS', 'NO_HIGH_CONFIDENCE_REQUIRED'];
    case 'HIGH_LIQUIDITY':
      return ['ALL', 'BUY_RULES', 'SELL_RULES', 'MULTI_TP', 'OVERLAP_BONUS'];
  }
}

export class MarketRegimeDetector {
  public classify(inputs: RegimeInputs): MarketRegimeClassification {
    const {
      adxValue,
      atrRatio,
      bbWidthRatio = Math.min(2, atrRatio),
      recentCandleBodyPctAvg = 0.5,
      rangeExpansionRatio = 1,
      spreadStatus,
      volatility,
      marketSession,
      nearbyHighImpactNews = false,
      volumeRatio = 1,
      emaGapAtrRatio = 0,
      rsiDeviationFrom50 = 0,
    } = inputs;

    const scores: Record<MarketRegime, number> = {
      TRENDING: 0,
      RANGING: 0,
      VOLATILE: 0,
      NEWS_DRIVEN: 0,
      LOW_LIQUIDITY: 0,
      HIGH_LIQUIDITY: 0,
    };

    // TRENDING: strong ADX, EMA gap, RSI away from 50, expanded but not extreme vol
    scores.TRENDING += clamp01((adxValue - 20) / 30) * 3;
    scores.TRENDING += clamp01(emaGapAtrRatio / 1.5) * 1.5;
    scores.TRENDING += clamp01(rsiDeviationFrom50 / 35) * 0.8;
    scores.TRENDING += clamp01(1 - Math.abs(recentCandleBodyPctAvg - 0.6) * 3) * 0.6;
    if (volatility === 'MEDIUM' || volatility === 'HIGH') scores.TRENDING += 0.4;
    if (volatility === 'EXTREME') scores.TRENDING -= 0.3;
    if (spreadStatus !== 'NORMAL') scores.TRENDING -= 0.2;

    // RANGING: low ADX, BB narrow, RSI near 50, small EMA gap
    scores.RANGING += clamp01((30 - adxValue) / 25) * 2.2;
    scores.RANGING += clamp01(1 - (bbWidthRatio - 0.7) * 1.5) * 1.5;
    scores.RANGING += clamp01(1 - rsiDeviationFrom50 / 25) * 1.2;
    scores.RANGING += clamp01(1 - emaGapAtrRatio) * 0.8;
    scores.RANGING += clamp01(1 - (rangeExpansionRatio - 1) * 1.5) * 0.6;
    if (spreadStatus === 'NORMAL') scores.RANGING += 0.2;
    if (marketSession === 'ASIA') scores.RANGING += 0.4;

    // VOLATILE: extreme ATR ratio, wide spread, expanded BB, big ranges
    scores.VOLATILE += clamp01((atrRatio - 1) / 1) * 3.0;
    scores.VOLATILE += clamp01((bbWidthRatio - 1) / 1) * 1.5;
    scores.VOLATILE += clamp01((rangeExpansionRatio - 1) * 2) * 1.2;
    if (volatility === 'HIGH') scores.VOLATILE += 0.8;
    if (volatility === 'EXTREME') scores.VOLATILE += 2.0;
    if (spreadStatus === 'WIDE') scores.VOLATILE += 0.5;
    if (spreadStatus === 'EXTREME') scores.VOLATILE += 1.2;

    // NEWS_DRIVEN: binary flag from calendar + extreme vol + wide
    if (nearbyHighImpactNews) scores.NEWS_DRIVEN += 4.0;
    if (volatility === 'EXTREME') scores.NEWS_DRIVEN += 0.5;
    if (rangeExpansionRatio > 1.8) scores.NEWS_DRIVEN += 0.5;
    if (spreadStatus === 'EXTREME') scores.NEWS_DRIVEN += 0.4;

    // LOW_LIQUIDITY: ASIA session, low volume, wide spreads (illiquid = bad fills)
    if (marketSession === 'ASIA') scores.LOW_LIQUIDITY += 2.5;
    scores.LOW_LIQUIDITY += clamp01(1 - volumeRatio) * 1.5;
    if (spreadStatus === 'WIDE') scores.LOW_LIQUIDITY += 0.5;
    if (spreadStatus === 'EXTREME') scores.LOW_LIQUIDITY += 0.7;
    // Exclude if big volume (overlap = high liquidity, not low)
    if (marketSession === 'OVERLAP') scores.LOW_LIQUIDITY -= 2.0;

    // HIGH_LIQUIDITY: OVERLAP / London+NY, high volume, tight spreads
    if (marketSession === 'OVERLAP') scores.HIGH_LIQUIDITY += 3.5;
    if (marketSession === 'LONDON' || marketSession === 'NEWYORK') scores.HIGH_LIQUIDITY += 1.5;
    scores.HIGH_LIQUIDITY += clamp01((volumeRatio - 0.5) / 1) * 1.5;
    if (spreadStatus === 'NORMAL') scores.HIGH_LIQUIDITY += 0.6;

    // Normalize scores to sum=~1 for readability (but preserve relative order)
    const total = Object.values(scores).reduce((s, v) => s + Math.max(0, v), 0) || 1;
    const normalized = { ...scores };
    (Object.keys(normalized) as MarketRegime[]).forEach((k) => {
      normalized[k] = Math.max(0, normalized[k]) / total;
    });

    const { regime, confidence } = softArgMax(normalized);
    const top2 = (Object.entries(normalized) as Array<[MarketRegime, number]>)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2);
    const reasoning =
      `Detected ${regime} (${(confidence * 100).toFixed(0)}%) — ` +
      top2.map(([r, s]) => `${r}:${(s * 100).toFixed(0)}%`).join(' / ') +
      `. ADX=${adxValue.toFixed(0)} ATRx=${atrRatio.toFixed(2)} Vol=${volatility} Spread=${spreadStatus} Session=${marketSession}${nearbyHighImpactNews ? ' + NEWS' : ''}.`;

    return {
      regime,
      confidence,
      scores: normalized,
      compatibleStrategies: compatibleFor(regime),
      reasoning,
    };
  }
}

export const marketRegimeDetector = new MarketRegimeDetector();
