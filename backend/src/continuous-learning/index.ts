/**
 * Continuous learning pipeline.
 *
 * On every completed trade:
 *  1. Store all relevant data
 *  2. Generate structured post-trade analysis
 *  3. Append labeled example to training dataset
 *
 * Periodically:
 *  4. Train candidate models in the background
 *  5. Compare vs production (validation + backtest)
 *  6. Recommend promotion only if consistently better
 *  7. Keep full audit logs
 */

import fs from 'fs';
import path from 'path';
import { appendAudit, readAuditLog } from '../monitoring/audit';
import { modelManager } from '../model-management';
import { backtestEngine } from '../backtesting';
import { monitoring } from '../monitoring';
import { logger, aiLogger } from '../logging';
import { liveTradeObserver } from '../analytics/tradeObserver';
import { persistFile } from '../storage/cloudPersistence';

const DATA_DIR = path.join(__dirname, '../../data/learning');
const DATASET_PATH = path.join(DATA_DIR, 'continuous_dataset.json');
const ANALYSES_PATH = path.join(DATA_DIR, 'post_trade_analyses.jsonl');
const STATE_PATH = path.join(DATA_DIR, 'learning_state.json');

const MIN_SAMPLES_TO_TRAIN = Number(process.env.CL_MIN_SAMPLES || 20);
const TRAIN_EVERY_N_TRADES = Number(process.env.CL_TRAIN_EVERY_N || 15);
const TRAIN_INTERVAL_MS = Number(process.env.CL_TRAIN_INTERVAL_MS || 6 * 60 * 60 * 1000); // 6h
const TRAIN_EPOCHS = Number(process.env.CL_TRAIN_EPOCHS || 40);

export interface CompletedTradePayload {
  ticket: string;
  symbol: string;
  direction: 'BUY' | 'SELL';
  outcome: 'WIN' | 'LOSS' | 'BREAKEVEN';
  profitPips: number;
  profitPercent?: number;
  profitDollars?: number;
  entryPrice?: number;
  closePrice?: number;
  sl?: number;
  tp?: number;
  lotSize?: number;
  riskPercent?: number;
  aiConfidence?: number;
  aiPrediction?: string;
  modelVersion?: string;
  entryFeatures?: any;
  closeFeatures?: any;
  marketSession?: string;
  durationMinutes?: number;
  entryTimestamp?: Date | string | number;
  closeTimestamp?: Date | string | number;
  notes?: string;
  spreadAtEntry?: number;
  pipSize?: number;
  atr14?: number;
  swingHighs?: number[];
  swingLows?: number[];
  newsEvents?: Array<{ title: string; impact: string; timestamp: number }>;
  maxFavorableExcursionPips?: number;
  maxAdverseExcursionPips?: number;
  // --- Ensemble + Online Learning (Phase 1, additive, all optional) ---
  fnnOutput?: any;
  cnnOutput?: any;
  lstmOutput?: any;
  ensembleOutput?: any;
  ensembleScore?: number;
  marketRegime?: string;
  regimeConfidence?: number;
  detectedPattern?: string;
  patternConfidence?: number;
  patternSuccess?: 'SUCCESS' | 'FAILURE' | 'BREAKEVEN' | null;
  misclassificationReason?: string | null;
  confidenceError?: number;
  predictionError?: number;
  executionQuality?: number;
  slippagePips?: number;
  entryLatencyMs?: number;
}

export interface TimingAnalysis {
  wasEarly: boolean;
  wasLate: boolean;
  score: number;
  reasoning: string;
  distanceToOptimalPips: number;
}

export interface SizingAnalysis {
  slTooSmall: boolean;
  slSizePips: number;
  slVsAtrRatio: number;
  tpTooClose: boolean;
  tpSizePips: number;
  rewardRiskRatio: number;
  reasoning: string;
}

export interface TrendAnalysis {
  ignored: boolean;
  direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  strength: number;
  reasoning: string;
}

export interface VolatilityAnalysis {
  tooHigh: boolean;
  level: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
  atrRatio: number;
  reasoning: string;
}

export interface SpreadAnalysis {
  responsible: boolean;
  status: 'NORMAL' | 'WIDE' | 'EXTREME';
  spreadPips: number;
  spreadVsProfitRatio: number;
  reasoning: string;
}

export interface NewsAnalysis {
  affected: boolean;
  eventsNearby: Array<{ title: string; impact: string; minutesOffset: number }>;
  reasoning: string;
}

export interface DeepPostTradeAnalysis {
  entryTiming: TimingAnalysis;
  slTpSizing: SizingAnalysis;
  trendAdherence: TrendAnalysis;
  volatilityContext: VolatilityAnalysis;
  spreadImpact: SpreadAnalysis;
  newsImpact: NewsAnalysis;
  excursion: {
    mfePips: number;
    maePips: number;
    efficiency: number;
  };
}

export interface PostTradeAnalysis {
  ticket: string;
  symbol: string;
  direction: string;
  outcome: string;
  profitPips: number;
  profitDollars: number;
  modelVersion?: string;
  aiConfidence?: number;
  analysis: {
    quality: 'GOOD' | 'ACCEPTABLE' | 'POOR';
    rMultiple: number;
    followedModel: boolean | null;
    session: string;
    mistakes: string[];
    strengths: string[];
    summary: string;
    deep?: DeepPostTradeAnalysis;
  };
  lessons: string[];
  labeledSampleId: string;
  createdAt: string;
}

interface LearningState {
  completedTradesSinceTrain: number;
  totalLabeledSamples: number;
  lastTrainAt: string | null;
  lastTrainVersion: string | null;
  lastRecommendation: string | null;
  backgroundTrainingEnabled: boolean;
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadState(): LearningState {
  ensureDir();
  if (!fs.existsSync(STATE_PATH)) {
    return {
      completedTradesSinceTrain: 0,
      totalLabeledSamples: 0,
      lastTrainAt: null,
      lastTrainVersion: null,
      lastRecommendation: null,
      backgroundTrainingEnabled: true,
    };
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
}

function saveState(state: LearningState) {
  ensureDir();
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  setImmediate(() => persistFile(STATE_PATH).catch(() => {}));
}

function loadDataset(): any[] {
  ensureDir();
  if (!fs.existsSync(DATASET_PATH)) {
    fs.writeFileSync(DATASET_PATH, JSON.stringify([], null, 2));
    setImmediate(() => persistFile(DATASET_PATH).catch(() => {}));
    return [];
  }
  try {
    const data = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf-8'));
    return Array.isArray(data) ? data : data.samples || [];
  } catch {
    return [];
  }
}

function saveDataset(samples: any[]) {
  ensureDir();
  fs.writeFileSync(DATASET_PATH, JSON.stringify(samples, null, 2));
  setImmediate(() => persistFile(DATASET_PATH).catch(() => {}));
}

export function featureVector(features: any): number[] {
  if (Array.isArray(features)) {
    const arr = features.map(Number);
    while (arr.length < 50) arr.push(0);
    return arr.slice(0, 50);
  }
  if (features?.normalizedFeatures && Array.isArray(features.normalizedFeatures)) {
    return featureVector(features.normalizedFeatures);
  }
  const keys = [
    'trendStrength', 'ema20DistancePips', 'ema50DistancePips', 'adxValue',
    'slope20', 'slope50', 'rsiStrength', 'cciValue', 'williamsR', 'atrRatio',
    'bbPercentWidth', 'bbPosition', 'structureStrength', 'prevCandleBodyPct', 'riskPercent',
  ];
  const vals = keys.map((k) => {
    const v = features?.[k];
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  });
  while (vals.length < 50) vals.push(0);
  return vals.slice(0, 50);
}

function analyzeEntryTiming(trade: CompletedTradePayload): TimingAnalysis {
  const entryPrice = Number(trade.entryPrice) || 0;
  const pipSize = Number(trade.pipSize) || 0.01;
  const ef = trade.entryFeatures || {};
  const swingHighs = trade.swingHighs || ef.swingHighs?.map((s: any) => s.price) || [];
  const swingLows = trade.swingLows || ef.swingLows?.map((s: any) => s.price) || [];
  const isBuy = trade.direction === 'BUY';

  let optimalEntry = entryPrice;
  if (swingLows.length >= 2 && isBuy) {
    optimalEntry = Math.max(...swingLows.slice(-2));
  } else if (swingHighs.length >= 2 && !isBuy) {
    optimalEntry = Math.min(...swingHighs.slice(-2));
  } else if (ef.nearestSupport && isBuy) {
    optimalEntry = Number(ef.nearestSupport);
  } else if (ef.nearestResistance && !isBuy) {
    optimalEntry = Number(ef.nearestResistance);
  }

  const distancePips = Math.abs(entryPrice - optimalEntry) / pipSize;
  const trendDir = ef.trendDirection;
  const rsi = Number(ef.rsiStrength) || 50;

  let wasEarly = false;
  let wasLate = false;
  let reasoning = '';

  if (isBuy) {
    if (rsi < 30 && distancePips > 5) {
      wasEarly = true;
      reasoning = `RSI ${rsi.toFixed(0)} indicated oversold, but entry was ${distancePips.toFixed(1)} pips above ideal support zone. Price likely had more downside before reversal.`;
    } else if (trendDir === 'BEARISH' && rsi > 60) {
      wasLate = true;
      reasoning = `Against BEARISH trend with RSI ${rsi.toFixed(0)}. Entry caught late in a retracement — momentum already exhausted.`;
    } else if (distancePips > 8) {
      wasLate = true;
      reasoning = `Entry ${distancePips.toFixed(1)} pips away from optimal structure zone (support at ${optimalEntry.toFixed(2)}). Fading the move instead of confirming structure.`;
    } else if (distancePips > 4) {
      wasEarly = distancePips > 6;
      reasoning = `Entry ${distancePips.toFixed(1)} pips from ideal zone. Moderate timing slippage — wait for candle close confirmation.`;
    } else {
      reasoning = `Entry well-timed: ${distancePips.toFixed(1)} pips from optimal zone (${optimalEntry.toFixed(2)}). RSI ${rsi.toFixed(0)} aligned.`;
    }
  } else {
    if (rsi > 70 && distancePips > 5) {
      wasEarly = true;
      reasoning = `RSI ${rsi.toFixed(0)} indicated overbought, but entry was ${distancePips.toFixed(1)} pips below ideal resistance zone. Price likely had more upside before reversal.`;
    } else if (trendDir === 'BULLISH' && rsi < 40) {
      wasLate = true;
      reasoning = `Against BULLISH trend with RSI ${rsi.toFixed(0)}. Entry caught late in a retracement — momentum already exhausted.`;
    } else if (distancePips > 8) {
      wasLate = true;
      reasoning = `Entry ${distancePips.toFixed(1)} pips away from optimal structure zone (resistance at ${optimalEntry.toFixed(2)}). Fading the move instead of confirming structure.`;
    } else if (distancePips > 4) {
      wasEarly = distancePips > 6;
      reasoning = `Entry ${distancePips.toFixed(1)} pips from ideal zone. Moderate timing slippage — wait for candle close confirmation.`;
    } else {
      reasoning = `Entry well-timed: ${distancePips.toFixed(1)} pips from optimal zone (${optimalEntry.toFixed(2)}). RSI ${rsi.toFixed(0)} aligned.`;
    }
  }

  const score = Math.max(0, 100 - distancePips * 4 - (wasEarly || wasLate ? 20 : 0));

  return {
    wasEarly,
    wasLate,
    score: Math.round(score),
    reasoning,
    distanceToOptimalPips: Math.round(distancePips * 10) / 10,
  };
}

function analyzeSizing(trade: CompletedTradePayload): SizingAnalysis {
  const entryPrice = Number(trade.entryPrice) || 0;
  const sl = Number(trade.sl) || 0;
  const tp = Number(trade.tp) || 0;
  const pipSize = Number(trade.pipSize) || 0.01;
  const atr = Number(trade.atr14) || Number(trade.entryFeatures?.atrRatio) * 100 * pipSize || pipSize * 10;

  const slSizePips = sl > 0 ? Math.abs(entryPrice - sl) / pipSize : 0;
  const tpSizePips = tp > 0 ? Math.abs(tp - entryPrice) / pipSize : 0;
  const slVsAtrRatio = atr > 0 ? slSizePips / (atr / pipSize) : 1;
  const rewardRiskRatio = slSizePips > 0 ? tpSizePips / slSizePips : 0;

  const slTooSmall = slSizePips > 0 && slSizePips < 5;
  const tpTooClose = tpSizePips > 0 && rewardRiskRatio < 1;

  let reasoning = '';
  if (slSizePips === 0) {
    reasoning = 'No stop-loss set. Critical risk management failure.';
  } else if (slTooSmall) {
    reasoning = `SL at ${slSizePips.toFixed(1)} pips is too tight. ATR-normalized SL should be ~${(atr / pipSize).toFixed(1)} pips (current ratio ${slVsAtrRatio.toFixed(2)}x). Likely stopped out on noise/spread.`;
  } else if (slVsAtrRatio < 0.6) {
    reasoning = `SL ${slSizePips.toFixed(1)} pips < 0.6x ATR-normalized range (${(atr / pipSize).toFixed(1)} pips). Prone to noise-driven shakeouts.`;
  } else if (slVsAtrRatio > 3) {
    reasoning = `SL ${slSizePips.toFixed(1)} pips > 3x ATR range. Over-exposing risk per trade without additional R compensation.`;
  } else {
    reasoning = `SL sizing appropriate: ${slSizePips.toFixed(1)} pips (${slVsAtrRatio.toFixed(2)}x ATR-normalized range).`;
  }

  if (tpSizePips === 0) {
    reasoning += ' No take-profit target set.';
  } else if (tpTooClose) {
    reasoning += ` TP at ${tpSizePips.toFixed(1)} pips gives R:R ${rewardRiskRatio.toFixed(2)} — below 1:1 minimum expectation. Leaving money on table vs risk incurred.`;
  } else if (rewardRiskRatio < 1.5) {
    reasoning += ` TP R:R ${rewardRiskRatio.toFixed(2)} is sub-1.5. Consider wider targets (SL gives room for noise, TP should compensate).`;
  } else {
    reasoning += ` TP R:R ${rewardRiskRatio.toFixed(2)} meets minimum expectancy bar.`;
  }

  return {
    slTooSmall,
    slSizePips: Math.round(slSizePips * 10) / 10,
    slVsAtrRatio: Math.round(slVsAtrRatio * 100) / 100,
    tpTooClose,
    tpSizePips: Math.round(tpSizePips * 10) / 10,
    rewardRiskRatio: Math.round(rewardRiskRatio * 100) / 100,
    reasoning,
  };
}

function analyzeTrend(trade: CompletedTradePayload): TrendAnalysis {
  const ef = trade.entryFeatures || {};
  const trendDir = ef.trendDirection || 'NEUTRAL';
  const trendStrength = Number(ef.trendStrength) || 0;
  const structureType = ef.structureType || 'RANGE';
  const adx = Number(ef.adxValue) || 0;
  const isBuy = trade.direction === 'BUY';

  let ignored = false;
  let reasoning = '';

  if (trendDir === 'BULLISH') {
    ignored = !isBuy;
    if (ignored) {
      reasoning = `Trend was BULLISH (ADX ${adx.toFixed(0)}, strength ${(trendStrength * 100).toFixed(0)}%, structure ${structureType}) but trade was SELL. Counter-trend entries need extreme confluence (FVG + OB + sweep) to justify.`;
    } else {
      reasoning = `Trade aligned with BULLISH trend: ADX ${adx.toFixed(0)}, structure ${structureType}, trend strength ${(trendStrength * 100).toFixed(0)}%.`;
    }
  } else if (trendDir === 'BEARISH') {
    ignored = isBuy;
    if (ignored) {
      reasoning = `Trend was BEARISH (ADX ${adx.toFixed(0)}, strength ${(trendStrength * 100).toFixed(0)}%, structure ${structureType}) but trade was BUY. Counter-trend entries need extreme confluence (FVG + OB + sweep) to justify.`;
    } else {
      reasoning = `Trade aligned with BEARISH trend: ADX ${adx.toFixed(0)}, structure ${structureType}, trend strength ${(trendStrength * 100).toFixed(0)}%.`;
    }
  } else {
    reasoning = `Trend was NEUTRAL/RANGE (ADX ${adx.toFixed(0)}). Requires range-bound tactics: buy support, sell resistance, tighter targets.`;
  }

  return {
    ignored,
    direction: trendDir,
    strength: Math.round(trendStrength * 100),
    reasoning,
  };
}

function analyzeVolatility(trade: CompletedTradePayload): VolatilityAnalysis {
  const ef = trade.entryFeatures || {};
  const level: any = ef.volatility || 'MEDIUM';
  const atrRatio = Number(ef.atrRatio) || 1;
  const pipSize = Number(trade.pipSize) || 0.01;
  const sl = Number(trade.sl) || 0;
  const entryPrice = Number(trade.entryPrice) || 0;
  const slSizePips = sl > 0 ? Math.abs(entryPrice - sl) / pipSize : 0;

  let tooHigh = false;
  let reasoning = '';

  if (level === 'EXTREME') {
    tooHigh = true;
    reasoning = `Volatility was EXTREME (ATR ratio ${atrRatio.toFixed(2)}x normal). SL ${slSizePips.toFixed(1)} pips likely insufficient — wide spreads + erratic chop = frequent noise stops.`;
  } else if (level === 'HIGH') {
    tooHigh = atrRatio > 1.6 && slSizePips > 0 && slSizePips < 10;
    reasoning = tooHigh
      ? `Volatility HIGH (ATR ${atrRatio.toFixed(2)}x) with SL ${slSizePips.toFixed(1)} pips. SL doesn't account for expanded range — wicks will hit stops before the thesis plays.`
      : `Volatility was HIGH (ATR ${atrRatio.toFixed(2)}x) but SL sizing accounted for it.`;
  } else if (level === 'MEDIUM') {
    reasoning = `Volatility MEDIUM (ATR ${atrRatio.toFixed(2)}x). Normal trading conditions, standard SL sizing applicable.`;
  } else {
    reasoning = `Volatility LOW (ATR ${atrRatio.toFixed(2)}x). Expect slower moves, wider TP patience required; spread eats into R more.`;
  }

  if (trade.outcome === 'LOSS' && tooHigh) {
    reasoning += ' This loss pattern is consistent with a volatility-driven shakeout.';
  }

  return {
    tooHigh,
    level,
    atrRatio: Math.round(atrRatio * 100) / 100,
    reasoning,
  };
}

function analyzeSpread(trade: CompletedTradePayload): SpreadAnalysis {
  const spread = Number(trade.spreadAtEntry) || Number(trade.entryFeatures?.spreadAtEntry) || 0;
  const pipSize = Number(trade.pipSize) || 0.01;
  const spreadPips = spread > 0 && pipSize > 0 ? spread / pipSize : (trade.entryFeatures?.spreadStatus === 'WIDE' ? 3 : trade.entryFeatures?.spreadStatus === 'EXTREME' ? 8 : 1);
  const ef = trade.entryFeatures || {};
  const status: any = ef.spreadStatus || (spreadPips > 5 ? 'EXTREME' : spreadPips > 2 ? 'WIDE' : 'NORMAL');
  const absProfitPips = Math.abs(Number(trade.profitPips));
  const spreadVsProfitRatio = absProfitPips > 0 ? spreadPips / absProfitPips : (spreadPips * 2);

  let responsible = false;
  let reasoning = '';

  if (status === 'EXTREME' || spreadPips > 5) {
    responsible = trade.outcome !== 'WIN' || spreadVsProfitRatio > 0.5;
    reasoning = `Spread was EXTREME: ${spreadPips.toFixed(1)} pips. ${responsible ? `This represents ${(spreadVsProfitRatio * 100).toFixed(0)}% of trade's P&L range — spread cost alone negated edge.` : `Trade won despite heavy spread cost (${(spreadVsProfitRatio * 100).toFixed(0)}% of range) — lucky fill or strong signal.`}`;
  } else if (status === 'WIDE' || spreadPips > 2) {
    responsible = spreadVsProfitRatio > 0.4 && trade.outcome === 'LOSS';
    reasoning = `Spread was WIDE: ${spreadPips.toFixed(1)} pips (${(spreadVsProfitRatio * 100).toFixed(0)}% of trade range). ${responsible ? 'Contributed to a loss that would otherwise be breakeven or small win.' : 'Not sole cause of outcome, but reduced net expectancy.'}`;
  } else {
    reasoning = `Spread NORMAL: ${spreadPips.toFixed(1)} pips (${(spreadVsProfitRatio * 100).toFixed(0)}% of trade range). Not a factor in outcome.`;
  }

  return {
    responsible,
    status,
    spreadPips: Math.round(spreadPips * 10) / 10,
    spreadVsProfitRatio: Math.round(spreadVsProfitRatio * 100) / 100,
    reasoning,
  };
}

function analyzeNews(trade: CompletedTradePayload): NewsAnalysis {
  const entryTs = trade.entryTimestamp ? new Date(trade.entryTimestamp).getTime() : Date.now() - 3600000;
  const events = trade.newsEvents || [];
  const WINDOW_MINUTES = 90;

  const nearby = events
    .map((e) => ({
      ...e,
      minutesOffset: Math.round((e.timestamp - entryTs) / 60000),
    }))
    .filter((e) => Math.abs(e.minutesOffset) <= WINDOW_MINUTES)
    .sort((a, b) => Math.abs(a.minutesOffset) - Math.abs(b.minutesOffset));

  const highImpact = nearby.filter((e) => e.impact === 'HIGH' || e.impact === 'EXTREME');
  const affected = highImpact.length > 0 || nearby.some((e) => Math.abs(e.minutesOffset) < 15 && (e.impact === 'MEDIUM' || e.impact === 'HIGH' || e.impact === 'EXTREME'));

  let reasoning = '';
  if (nearby.length === 0) {
    reasoning = `No news events within ${WINDOW_MINUTES}-min window of entry. News was not a factor.`;
  } else if (affected) {
    const worst = highImpact[0] || nearby[0];
    reasoning = `${nearby.length} news event(s) within ${WINDOW_MINUTES} min of entry. ${worst.impact}-impact event \"${worst.title}\" was ${worst.minutesOffset > 0 ? worst.minutesOffset + ' min after' : Math.abs(worst.minutesOffset) + ' min before'} entry. Volatility spike likely distorted entry/SL/TP levels.`;
  } else {
    reasoning = `${nearby.length} low/medium news event(s) nearby but none high-impact within ±15 min. News contribution to outcome is minimal.`;
  }

  return {
    affected,
    eventsNearby: nearby.map((e) => ({ title: e.title, impact: e.impact, minutesOffset: e.minutesOffset })),
    reasoning,
  };
}

function analyzeTrade(trade: CompletedTradePayload): PostTradeAnalysis {
  const risk = Math.abs(Number(trade.riskPercent) || 1);
  const rMultiple = risk > 0 ? Number(trade.profitPercent || trade.profitPips / 100) / (risk / 100 || 0.01) : 0;
  const mistakes: string[] = [];
  const strengths: string[] = [];
  const lessons: string[] = [];

  const entryTiming = analyzeEntryTiming(trade);
  const slTpSizing = analyzeSizing(trade);
  const trendAdherence = analyzeTrend(trade);
  const volatilityContext = analyzeVolatility(trade);
  const spreadImpact = analyzeSpread(trade);
  const newsImpact = analyzeNews(trade);

  const mfeRaw = trade.maxFavorableExcursionPips;
  const maeRaw = trade.maxAdverseExcursionPips;
  const mfePips =
    mfeRaw !== undefined && mfeRaw !== null && Number.isFinite(Number(mfeRaw))
      ? Math.max(0, Number(mfeRaw))
      : Math.max(0, Number(trade.profitPips) || 0);
  const maePips =
    maeRaw !== undefined && maeRaw !== null && Number.isFinite(Number(maeRaw))
      ? Math.max(0, Number(maeRaw))
      : Math.max(0, -(Number(trade.profitPips) || 0));
  const maxExcursion = mfePips + maePips || 1;
  const efficiency = Number(trade.profitPips) / maxExcursion;

  const deep: DeepPostTradeAnalysis = {
    entryTiming,
    slTpSizing,
    trendAdherence,
    volatilityContext,
    spreadImpact,
    newsImpact,
    excursion: {
      mfePips: Math.round(mfePips * 10) / 10,
      maePips: Math.round(maePips * 10) / 10,
      efficiency: Math.round(efficiency * 100) / 100,
    },
  };

  if (entryTiming.wasEarly) { mistakes.push('Entry was too early'); lessons.push(entryTiming.reasoning); }
  if (entryTiming.wasLate) { mistakes.push('Entry was too late'); lessons.push(entryTiming.reasoning); }
  if (slTpSizing.slTooSmall) { mistakes.push('Stop-loss too small'); lessons.push(slTpSizing.reasoning); }
  if (slTpSizing.tpTooClose) { mistakes.push('Take-profit too close'); lessons.push(slTpSizing.reasoning); }
  if (trendAdherence.ignored) { mistakes.push('Trend was ignored'); lessons.push(trendAdherence.reasoning); }
  if (volatilityContext.tooHigh) { mistakes.push('Volatility was too high'); lessons.push(volatilityContext.reasoning); }
  if (spreadImpact.responsible) { mistakes.push('Spread was responsible'); lessons.push(spreadImpact.reasoning); }
  if (newsImpact.affected) { mistakes.push('News affected trade'); lessons.push(newsImpact.reasoning); }

  if (trade.outcome === 'LOSS') {
    if ((trade.aiConfidence || 0) < 0.5) {
      mistakes.push('Low AI confidence entry that lost');
      lessons.push('Skip entries when confidence < 0.5');
    }
    if ((trade.riskPercent || 0) > 2) {
      mistakes.push('Risk above 2%');
      lessons.push('Cap risk at 1–1.5% per trade');
    }
    if (trade.marketSession === 'ASIA') {
      mistakes.push('Loss during ASIA session');
      lessons.push('Prefer London/NY/Overlap sessions');
    }
  }

  if (trade.outcome === 'WIN') {
    strengths.push('Positive expectancy trade');
    if ((trade.aiConfidence || 0) >= 0.7) strengths.push('High-confidence AI alignment');
    if (!trendAdherence.ignored) strengths.push('Trend-aligned entry');
    if (entryTiming.score > 80) strengths.push('Excellent entry timing');
  }

  let followedModel: boolean | null = null;
  if (trade.aiPrediction) {
    followedModel = trade.aiPrediction.toUpperCase() === trade.direction;
    if (!followedModel && trade.outcome === 'LOSS') {
      mistakes.push('Traded against AI prediction');
      lessons.push('Align discretionary entries with model or skip');
    }
  }

  const quality: 'GOOD' | 'ACCEPTABLE' | 'POOR' =
    trade.outcome === 'WIN' && mistakes.length === 0
      ? 'GOOD'
      : trade.outcome === 'BREAKEVEN' || mistakes.length <= 1
        ? 'ACCEPTABLE'
        : 'POOR';

  const eightQs = [
    `Entry early? ${entryTiming.wasEarly ? 'YES' : 'NO'}`,
    `Entry late? ${entryTiming.wasLate ? 'YES' : 'NO'}`,
    `SL too small? ${slTpSizing.slTooSmall ? 'YES' : 'NO'}`,
    `TP too close? ${slTpSizing.tpTooClose ? 'YES' : 'NO'}`,
    `Trend ignored? ${trendAdherence.ignored ? 'YES' : 'NO'}`,
    `Volatility too high? ${volatilityContext.tooHigh ? 'YES' : 'NO'}`,
    `Spread responsible? ${spreadImpact.responsible ? 'YES' : 'NO'}`,
    `News affected? ${newsImpact.affected ? 'YES' : 'NO'}`,
  ].join(' | ');

  const summary =
    `${trade.direction} ${trade.symbol} → ${trade.outcome} ` +
    `(${Number(trade.profitPips).toFixed(1)} pips). Quality=${quality}. ` +
    `${eightQs}. ` +
    (lessons[0] || 'No critical lessons.');

  const labeledSampleId = `sample_${trade.ticket}_${Date.now()}`;

  return {
    ticket: trade.ticket,
    symbol: trade.symbol,
    direction: trade.direction,
    outcome: trade.outcome,
    profitPips: Number(trade.profitPips),
    profitDollars: Number(trade.profitDollars || 0),
    modelVersion: trade.modelVersion,
    aiConfidence: trade.aiConfidence,
    analysis: {
      quality,
      rMultiple: Number.isFinite(rMultiple) ? rMultiple : 0,
      followedModel,
      session: trade.marketSession || 'UNKNOWN',
      mistakes,
      strengths,
      summary,
      deep,
    },
    lessons: Array.from(new Set(lessons)),
    labeledSampleId,
    createdAt: new Date().toISOString(),
  };
}

function toLabeledSample(trade: CompletedTradePayload, analysis: PostTradeAnalysis) {
  const d: any = analysis.analysis?.deep || {};
  return {
    id: analysis.labeledSampleId,
    ticket: trade.ticket,
    symbol: trade.symbol,
    direction: trade.direction,
    features: featureVector(trade.entryFeatures),
    entryFeatures: trade.entryFeatures || {},
    closeFeatures: trade.closeFeatures || null,
    target: {
      win: trade.outcome === 'WIN',
      profit_pips: Number(trade.profitPips),
      profit_percent: Number(trade.profitPercent || 0),
      direction: trade.direction,
      duration: Number(trade.durationMinutes || 30),
      // Per-dimension targets useful for multi-task training later
      // (each becomes a trainable classification target alongside WR/P&L)
      entry_was_early: !!d.entryTiming?.wasEarly,
      entry_was_late: !!d.entryTiming?.wasLate,
      sl_too_small: !!d.slTpSizing?.slTooSmall,
      tp_too_close: !!d.slTpSizing?.tpTooClose,
      trend_ignored: !!d.trendAdherence?.ignored,
      volatility_too_high: !!d.volatilityContext?.tooHigh,
      spread_responsible: !!d.spreadImpact?.responsible,
      news_affected: !!d.newsImpact?.affected,
      pattern_success: trade.patternSuccess || null,
    },
    outcome: trade.outcome,
    modelVersion: trade.modelVersion,
    aiConfidence: trade.aiConfidence,
    postTradeQuality: analysis.analysis.quality,
    timestamp: trade.closeTimestamp || trade.entryTimestamp || Date.now(),
    labeledAt: analysis.createdAt,
    // --- Ensemble + Online Learning (Phase 1, all nullable) ---
    // Stored so future training runs can slice/dice by per-model correctness
    // without re-running the gate logic offline.
    ensembleScore: trade.ensembleScore ?? null,
    fnnConfidence: trade.fnnOutput ? (trade.fnnOutput.tradeConfidence ?? trade.fnnOutput.confidence ?? null) : null,
    cnnConfidence: trade.cnnOutput ? (trade.cnnOutput.patternConfidence ?? null) : null,
    lstmConfidence: trade.lstmOutput ? (trade.lstmOutput.confidence ?? null) : null,
    marketRegime: trade.marketRegime || null,
    regimeConfidence: trade.regimeConfidence ?? null,
    detectedPattern: trade.detectedPattern || d?.explainability?.patternDetected || null,
    patternConfidence: trade.patternConfidence ?? null,
    patternSuccess: trade.patternSuccess ?? null,
    misclassificationReason: trade.misclassificationReason ?? null,
    confidenceError:
      trade.confidenceError !== undefined && trade.confidenceError !== null
        ? Number(trade.confidenceError)
        : (trade.aiConfidence != null
          ? Math.abs(
              Number(trade.aiConfidence) -
              (trade.outcome === 'WIN' ? 1 : trade.outcome === 'LOSS' ? 0 : 0.5)
            )
          : null),
    predictionError:
      trade.predictionError !== undefined && trade.predictionError !== null
        ? Number(trade.predictionError)
        : null,
    executionQuality: trade.executionQuality ?? null,
    slippagePips: trade.slippagePips ?? null,
    entryLatencyMs: trade.entryLatencyMs ?? null,
    // Per-dimension 0-1 scores for downstream regression/calibration models
    dimensionScores: {
      entryTiming: Number(d.entryTiming?.score ?? 50) / 100,
      slVsAtrRatio: Number(d.slTpSizing?.slVsAtrRatio ?? 1),
      rewardRiskRatio: Number(d.slTpSizing?.rewardRiskRatio ?? 1),
      trendStrengthPct: Number(d.trendAdherence?.strength ?? 50) / 100,
      atrRatio: Number(d.volatilityContext?.atrRatio ?? 1),
      spreadVsProfitRatio: Number(d.spreadImpact?.spreadVsProfitRatio ?? 0),
      newsEventsNearby: Number(d.newsImpact?.eventsNearby?.length ?? 0),
      tradeEfficiency: Number(d.excursion?.efficiency ?? 0),
    },
  };
}

export class ContinuousLearningPipeline {
  private timer: NodeJS.Timeout | null = null;
  private trainingInFlight = false;

  start() {
    const state = loadState();
    if (!state.backgroundTrainingEnabled) {
      aiLogger.info('Continuous learning background training disabled');
      return;
    }
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.maybeTrainBackground('interval').catch((e) => {
        monitoring.trackError(`CL train interval failed: ${e}`, 'ERROR');
      });
    }, TRAIN_INTERVAL_MS);
    this.timer.unref?.();
    aiLogger.info('Continuous learning scheduler started', {
      everyMs: TRAIN_INTERVAL_MS,
      everyNTrades: TRAIN_EVERY_N_TRADES,
      minSamples: MIN_SAMPLES_TO_TRAIN,
    });
    appendAudit('LEARNING', 'SCHEDULER_STARTED', {
      TRAIN_INTERVAL_MS,
      TRAIN_EVERY_N_TRADES,
      MIN_SAMPLES_TO_TRAIN,
    });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Called when a trade completes.
   */
  async onTradeCompleted(trade: CompletedTradePayload): Promise<PostTradeAnalysis> {
    ensureDir();
    const analysis = analyzeTrade(trade);

    // 1 + 2: store analysis
    fs.appendFileSync(ANALYSES_PATH, JSON.stringify(analysis) + '\n');
    setImmediate(() => persistFile(ANALYSES_PATH).catch(() => {}));

    // 3: labeled dataset
    const dataset = loadDataset();
    const sample = toLabeledSample(trade, analysis);
    dataset.push(sample);
    saveDataset(dataset);

    const state = loadState();
    state.completedTradesSinceTrain += 1;
    state.totalLabeledSamples = dataset.length;
    saveState(state);

    appendAudit(
      'LEARNING',
      'TRADE_LABELED',
      {
        ticket: trade.ticket,
        outcome: trade.outcome,
        quality: analysis.analysis.quality,
        datasetSize: dataset.length,
      },
      trade.modelVersion
    );

    aiLogger.info(`Post-trade analysis stored for ${trade.ticket}`, analysis.analysis.summary);

    // Trigger train every N trades
    if (state.completedTradesSinceTrain >= TRAIN_EVERY_N_TRADES) {
      this.maybeTrainBackground('trade_threshold').catch((e) =>
        monitoring.trackError(`CL train trigger failed: ${e}`, 'ERROR')
      );
    }

    return analysis;
  }

  getDatasetPath() {
    return DATASET_PATH;
  }

  getStatus() {
    const state = loadState();
    const dataset = loadDataset();
    const live = liveTradeObserver.getStatus();
    return {
      ...state,
      datasetSize: dataset.length,
      datasetPath: DATASET_PATH,
      minSamplesToTrain: MIN_SAMPLES_TO_TRAIN,
      trainEveryNTrades: TRAIN_EVERY_N_TRADES,
      trainingInFlight: this.trainingInFlight,
      recentAnalyses: this.recentAnalyses(10),
      recentAudit: readAuditLog(20, 'LEARNING'),
      // Live watch — open trades rated while running
      liveWatch: live,
      readyToTrain: dataset.length >= MIN_SAMPLES_TO_TRAIN,
    };
  }

  recentAnalyses(limit = 20): PostTradeAnalysis[] {
    ensureDir();
    if (!fs.existsSync(ANALYSES_PATH)) return [];
    const lines = fs.readFileSync(ANALYSES_PATH, 'utf-8').trim().split('\n').filter(Boolean);
    const out: PostTradeAnalysis[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        out.push(JSON.parse(lines[i]));
      } catch {
        // skip
      }
    }
    return out;
  }

  async maybeTrainBackground(reason: string): Promise<any> {
    if (this.trainingInFlight) {
      return { skipped: true, reason: 'already_training' };
    }
    const status = modelManager.getTrainingStatus();
    if (status.status === 'RUNNING') {
      return { skipped: true, reason: 'model_manager_busy' };
    }

    const dataset = loadDataset();
    if (dataset.length < MIN_SAMPLES_TO_TRAIN) {
      return {
        skipped: true,
        reason: `need_${MIN_SAMPLES_TO_TRAIN}_samples_have_${dataset.length}`,
      };
    }

    this.trainingInFlight = true;
    appendAudit('LEARNING', 'BACKGROUND_TRAIN_STARTED', { reason, samples: dataset.length });

    try {
      // Merge continuous dataset with example data if tiny — already enough samples
      const result = await modelManager.startTraining({
        dataPath: DATASET_PATH,
        epochs: TRAIN_EPOCHS,
      });

      const state = loadState();
      state.completedTradesSinceTrain = 0;
      state.lastTrainAt = new Date().toISOString();
      state.lastTrainVersion = result.best_candidate?.version || null;

      // 5 + 6: validation already in pipeline; also run backtest on candidate + production
      const candidateVersion = result.best_candidate?.version;
      let promotion = result.best_candidate?.deployment_recommendation || 'NO';
      let promotionReason = result.best_candidate?.recommendation_reason || '';

      if (candidateVersion && result.success) {
        const evalResult = await this.evaluateCandidateFully(candidateVersion);
        promotion = evalResult.recommend;
        promotionReason = evalResult.reason;
        state.lastRecommendation = promotion;

        appendAudit(
          'EVALUATION',
          'CANDIDATE_FULL_EVAL',
          evalResult,
          candidateVersion
        );
      }

      saveState(state);
      appendAudit(
        'TRAINING',
        'BACKGROUND_TRAIN_COMPLETED',
        {
          success: result.success,
          version: candidateVersion,
          recommendation: promotion,
          reason: promotionReason,
          auto_promoted: false,
        },
        candidateVersion
      );

      return {
        ...result,
        deployment_recommendation: promotion,
        recommendation_reason: promotionReason,
        auto_promoted: false,
      };
    } catch (e) {
      monitoring.trackFailure(`Background training failed: ${e}`, 'ERROR');
      appendAudit('TRAINING', 'BACKGROUND_TRAIN_FAILED', { error: String(e) });
      return { success: false, error: String(e), auto_promoted: false };
    } finally {
      this.trainingInFlight = false;
    }
  }

  /**
   * Require candidate to beat production on BOTH holdout validation (from train)
   * AND a backtest replay before recommending promotion.
   */
  async evaluateCandidateFully(candidateVersion: string): Promise<{
    recommend: 'YES' | 'NO' | 'MONITOR';
    reason: string;
    validation: any;
    backtestCandidate: any;
    backtestProduction: any;
  }> {
    const production = modelManager.getProductionVersion();
    const dataPath = fs.existsSync(DATASET_PATH) && loadDataset().length >= 10
      ? DATASET_PATH
      : path.join(__dirname, '../../python/example_training_data.json');

    const [btCand, btProd] = await Promise.all([
      backtestEngine.run({ dataPath, modelVersion: candidateVersion }),
      production
        ? backtestEngine.run({ dataPath, modelVersion: production })
        : Promise.resolve(null),
    ]);

    // Pull validation comparison from candidate metadata if present
    const metaPath = path.join(
      __dirname,
      '../../python/saved_models',
      `model_${candidateVersion}`,
      'metadata.json'
    );
    let validationCompare: any = null;
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        validationCompare = meta.evaluation?.comparison || null;
      } catch {
        validationCompare = null;
      }
    }

    const valYes = validationCompare?.recommend_deploy === 'YES';
    let btYes = false;
    let btReason = 'No production backtest baseline';

    if (btCand?.success && btProd?.success) {
      const checks = [
        Number(btCand.win_rate) >= Number(btProd.win_rate) + 0.02,
        Number(btCand.profit_factor) >= Number(btProd.profit_factor) + 0.05,
        Number(btCand.sharpe_ratio) >= Number(btProd.sharpe_ratio),
        Number(btCand.max_drawdown) <= Number(btProd.max_drawdown),
      ];
      const wins = checks.filter(Boolean).length;
      btYes = wins >= 3;
      btReason = `Backtest beats production on ${wins}/4 metrics`;
    } else if (btCand?.success && !production) {
      btYes = Number(btCand.profit_factor) > 1.2 && Number(btCand.win_rate) >= 0.55;
      btReason = 'No production model — candidate meets absolute backtest bar';
    } else {
      btReason = `Backtest incomplete: cand=${btCand?.success} prod=${btProd?.success}`;
    }

    let recommend: 'YES' | 'NO' | 'MONITOR' = 'NO';
    let reason = '';
    if (valYes && btYes) {
      recommend = 'YES';
      reason =
        'Candidate consistently outperforms production on validation holdout AND backtest. Manual promote required.';
    } else if (valYes || btYes) {
      recommend = 'MONITOR';
      reason = `Partial outperformance — validation=${valYes}, backtest=${btYes}. ${btReason}`;
    } else {
      recommend = 'NO';
      reason = `Does not consistently beat production. Validation YES=${valYes}. ${btReason}`;
    }

    // Never auto-promote
    return {
      recommend,
      reason,
      validation: validationCompare,
      backtestCandidate: {
        win_rate: btCand?.win_rate,
        profit_factor: btCand?.profit_factor,
        sharpe_ratio: btCand?.sharpe_ratio,
        max_drawdown: btCand?.max_drawdown,
        n_trades: btCand?.n_trades,
      },
      backtestProduction: btProd
        ? {
            win_rate: btProd.win_rate,
            profit_factor: btProd.profit_factor,
            sharpe_ratio: btProd.sharpe_ratio,
            max_drawdown: btProd.max_drawdown,
            n_trades: btProd.n_trades,
          }
        : null,
    };
  }
}

export const continuousLearning = new ContinuousLearningPipeline();
