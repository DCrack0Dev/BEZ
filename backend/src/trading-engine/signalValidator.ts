import { CONFIG } from '../config/tradingConfig';
import { calculateRisk, RiskParams } from '../risk-manager/riskEngine';
import { TradeSignal, FeatureSet, Candle, MT5Payload, MarketRegime } from '../types';
import { v4 as uuidv4 } from 'uuid';

export const calculateATR = (candles: Candle[], period: number = 14): number => {
  if (candles.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const trueRange = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - prev.close),
      Math.abs(candles[i].low - prev.close)
    );
    trs.push(trueRange);
  }
  const atr = trs.slice(-period).reduce((a, b) => a + b, 0) / period;
  return atr;
};

export const getCurrentSession = (): "ASIA" | "LONDON" | "NEWYORK" | "OVERLAP" => {
  const hourUTC = new Date().getUTCHours();
  const isAsia = hourUTC >= 0 && hourUTC < 9;
  const isLondon = hourUTC >= 8 && hourUTC < 17;
  const isNewYork = hourUTC >= 13 && hourUTC < 22;
  if (isLondon && isNewYork) return "OVERLAP";
  if (isLondon) return "LONDON";
  if (isNewYork) return "NEWYORK";
  return "ASIA";
};

export const calculateSwingHighs = (candles: Candle[], lookback: number = 2): number[] => {
  const swingHighs: number[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const isSwingHigh = candles.slice(i - lookback, i).every(c => c.high < candles[i].high) &&
                        candles.slice(i + 1, i + lookback + 1).every(c => c.high < candles[i].high);
    if (isSwingHigh) swingHighs.push(candles[i].high);
  }
  return swingHighs;
};

export const calculateSwingLows = (candles: Candle[], lookback: number = 2): number[] => {
  const swingLows: number[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const isSwingLow = candles.slice(i - lookback, i).every(c => c.low > candles[i].low) &&
                       candles.slice(i + 1, i + lookback + 1).every(c => c.low > candles[i].low);
    if (isSwingLow) swingLows.push(candles[i].low);
  }
  return swingLows;
};

export const calculateEMA = (candles: Candle[], period: number): number => {
  if (candles.length < period) return 0;
  const k = 2 / (period + 1);
  let ema = candles.slice(candles.length - period, candles.length).reduce((a, c) => a + c.close, 0) / period;
  for (let i = candles.length - period - 1; i >= 0; i--) {
    ema = candles[i].close * k + ema * (1 - k);
  }
  return ema;
};

const REGIME_SL_MULTIPLIERS: Record<MarketRegime, number> = {
  TRENDING: 1.2,
  RANGING: 0.8,
  VOLATILE: 2.0,
  NEWS_DRIVEN: 2.5,
  LOW_LIQUIDITY: 1.5,
  HIGH_LIQUIDITY: 1.0,
};

const REGIME_TP_RR: Record<MarketRegime, { tp1: number; tp2: number; tp3: number }> = {
  TRENDING: { tp1: 2.0, tp2: 3.5, tp3: 5.5 },
  RANGING: { tp1: 1.0, tp2: 1.8, tp3: 2.5 },
  VOLATILE: { tp1: 1.2, tp2: 2.0, tp3: 2.8 },
  NEWS_DRIVEN: { tp1: 1.0, tp2: 1.5, tp3: 2.0 },
  LOW_LIQUIDITY: { tp1: 1.0, tp2: 1.5, tp3: 2.0 },
  HIGH_LIQUIDITY: { tp1: 1.8, tp2: 3.0, tp3: 5.0 },
};

interface DynamicSizingResult {
  stopLoss: number;
  tpLevels: [number, number, number];
  slDistancePips: number;
}

function calculateDynamicSLTP(
  direction: 'BUY' | 'SELL',
  price: number,
  atr14: number,
  pipSize: number,
  pointSize: number,
  isXAUUSD: boolean,
  swingHighs: number[],
  swingLows: number[],
  features: FeatureSet | undefined,
  regime: MarketRegime = 'HIGH_LIQUIDITY',
  regimeConfidence: number = 0.6
): DynamicSizingResult {
  const unit = isXAUUSD ? pointSize : pipSize;
  const slMultiplier = REGIME_SL_MULTIPLIERS[regime] ?? 1.2;
  const atrSLDistance = atr14 * slMultiplier;

  const nearestResistanceRaw = swingHighs.filter(h => h >= price);
  const nearestResistance = nearestResistanceRaw.length > 0 ? Math.min(...nearestResistanceRaw) : price + unit * 100;
  const nearestSupportRaw = swingLows.filter(l => l <= price);
  const nearestSupport = nearestSupportRaw.length > 0 ? Math.max(...nearestSupportRaw) : price - unit * 100;

  const fvgDetails = features?.fvgDetails;
  const obDetails = features?.orderBlockDetails;

  let structureSL: number;
  if (direction === 'BUY') {
    let candidate = nearestSupport - unit * 2;
    if (obDetails && features?.orderBlockConfirmed === 'BULLISH') {
      candidate = Math.min(candidate, obDetails.bottom - unit);
    }
    if (fvgDetails && features?.fvgPresent === 'BULLISH' && fvgDetails.type !== 'NONE') {
      candidate = Math.min(candidate, Math.min(fvgDetails.startPrice, fvgDetails.endPrice) - unit);
    }
    structureSL = candidate;
  } else {
    let candidate = nearestResistance + unit * 2;
    if (obDetails && features?.orderBlockConfirmed === 'BEARISH') {
      candidate = Math.max(candidate, obDetails.top + unit);
    }
    if (fvgDetails && features?.fvgPresent === 'BEARISH' && fvgDetails.type !== 'NONE') {
      candidate = Math.max(candidate, Math.max(fvgDetails.startPrice, fvgDetails.endPrice) + unit);
    }
    structureSL = candidate;
  }

  const atrBasedSL = direction === 'BUY' ? price - atrSLDistance : price + atrSLDistance;
  const structureDistance = Math.abs(price - structureSL);
  const atrDistance = Math.abs(price - atrBasedSL);
  const confidenceBoost = 1 + (regimeConfidence - 0.5) * 0.3;

  let stopLoss: number;
  if (direction === 'BUY') {
    stopLoss = structureDistance > atrDistance * 0.5
      ? Math.min(atrBasedSL, structureSL)
      : atrBasedSL;
    stopLoss = stopLoss - unit * (CONFIG.spreadBuffer * (isXAUUSD ? 0.03 : 1));
  } else {
    stopLoss = structureDistance > atrDistance * 0.5
      ? Math.max(atrBasedSL, structureSL)
      : atrBasedSL;
    stopLoss = stopLoss + unit * (CONFIG.spreadBuffer * (isXAUUSD ? 0.03 : 1));
  }

  const rawSLDistance = Math.abs(price - stopLoss);
  const slDistance = Math.max(rawSLDistance, atr14 * 0.6);
  const slDistancePips = unit > 0 ? slDistance / unit : slDistance;

  const rr = REGIME_TP_RR[regime] ?? REGIME_TP_RR.HIGH_LIQUIDITY;
  const tpR1 = rr.tp1 * confidenceBoost;
  const tpR2 = rr.tp2 * confidenceBoost;
  const tpR3 = rr.tp3 * confidenceBoost;

  const tp1 = direction === 'BUY' ? price + slDistance * tpR1 : price - slDistance * tpR1;
  const tp2 = direction === 'BUY' ? price + slDistance * tpR2 : price - slDistance * tpR2;
  let tp3: number;
  if (direction === 'BUY') {
    tp3 = nearestResistanceRaw.length > 0 ? nearestResistance + unit : price + slDistance * tpR3;
  } else {
    tp3 = nearestSupportRaw.length > 0 ? nearestSupport - unit : price - slDistance * tpR3;
  }

  return { stopLoss, tpLevels: [tp1, tp2, tp3], slDistancePips };
}

export const validateSignal = (
  payload: MT5Payload,
  features?: FeatureSet,
  regime?: MarketRegime,
  regimeConfidence: number = 0.6
): TradeSignal | null => {
  const {
    symbol, candles, spread, balance, equity, pipSize, pointSize,
    ema20, ema20Prev, newsFilterActive,
    openPositionsCount,
  } = payload;

  const N = CONFIG.reversalCandleCount;
  if (candles.length < N + 1) return null;

  const atr14 = payload.atr14 !== undefined ? payload.atr14 : calculateATR(candles, 14);
  const swingHighsPrices = payload.swingHighs !== undefined ? payload.swingHighs : calculateSwingHighs(candles);
  const swingLowsPrices = payload.swingLows !== undefined ? payload.swingLows : calculateSwingLows(candles);

  const currentCandle = candles[candles.length - 1];
  const priorCandle = candles[candles.length - 2];
  const price = currentCandle.close;
  const isXAUUSD = symbol.includes("XAU") || symbol.includes("GOLD");

  const drawdown = balance > 0 ? ((balance - equity) / balance) * 100 : 0;
  const maxOpen = isXAUUSD ? 2 : CONFIG.maxOpenTrades;
  const maxSpreadPts =
    (payload as MT5Payload & { maxSpreadPoints?: number }).maxSpreadPoints ??
    CONFIG.maxSpreadPoints;
  const spreadXAUUSDOk = spread <= maxSpreadPts;
  const spreadForexOk = (() => {
    const spreadPips = pointSize > 0 ? (spread * pointSize) / pipSize : spread;
    return spreadPips <= CONFIG.maxSpreadPips;
  })();
  const timezoneTradingEnabled = payload.timezoneTradingEnabled !== false;
  const currentSession = getCurrentSession();
  const sessionOk = true; // USER REQUEST: removed session filter entirely; allow any session
  const marginOk = payload.marginLevel === undefined || payload.marginLevel >= CONFIG.minMarginLevelPercent;
  const dailyLossOk = payload.dailyLossPercent === undefined || payload.dailyLossPercent < CONFIG.maxDailyLossPercent;

  interface GateResult { name: string; passed: boolean; }
  const hardGates: GateResult[] = [
    { name: 'drawdown', passed: drawdown <= CONFIG.maxDrawdownPercent },
    { name: 'maxOpenTrades', passed: openPositionsCount < maxOpen },
    { name: 'spread', passed: true }, // USER REQUEST: removed spread limit entirely
    { name: 'session', passed: sessionOk },
    { name: 'marginLevel', passed: marginOk },
    { name: 'dailyLoss', passed: dailyLossOk },
    { name: 'newsFilter', passed: !newsFilterActive },
  ];
  const hardGatesPassed = hardGates.filter(g => g.passed).length;
  const hardGateThreshold = 3; // USER REQUEST: much lower threshold (only critical gates: drawdown/maxOpen/margin/dailyLoss count)

  if (!features) {
    return null;
  }

  const isBullishStructure = features.trendDirection === 'BULLISH';
  const isBearishStructure = features.trendDirection === 'BEARISH';
  const trendStrengthOk = features.trendStrength >= 0.35;
  const structureStrengthOk = (features.structureStrength ?? 0) >= 0.4;
  const trendConfidenceOk = (trendStrengthOk && (isBullishStructure || isBearishStructure)) || structureStrengthOk;

  const hasBullishOB = features.orderBlockConfirmed === 'BULLISH';
  const hasBearishOB = features.orderBlockConfirmed === 'BEARISH';
  const hasBullishFVG = features.fvgPresent === 'BULLISH';
  const hasBearishFVG = features.fvgPresent === 'BEARISH';

  const candleType = features.prevCandleType;
  const candlePattern = features.prevCandlePattern;

  const isHammer = candleType === 'HAMMER';
  const isShootingStar = candleType === 'SHOOTING_STAR';
  const isMarubozu = candleType === 'MARUBOZU';
  const isBullishEngulfing = candlePattern === 'BULLISH_ENGULFING';
  const isBearishEngulfing = candlePattern === 'BEARISH_ENGULFING';

  const bullishPatternConfirm = isHammer || isBullishEngulfing || isMarubozu;
  const bearishPatternConfirm = isShootingStar || isBearishEngulfing || (isMarubozu && isBearishStructure);

  const fvgDetails = features.fvgDetails;
  const obDetails = features.orderBlockDetails;

  let fvgProximityOk = true; // USER REQUEST: not strict — price doesn't have to be exactly at FVG
  let obProximityOk = true;  // USER REQUEST: not strict — price doesn't have to be exactly at OB

  const bullishSMC = hasBullishOB || hasBullishFVG; // USER REQUEST: proximity no longer required
  const bearishSMC = hasBearishOB || hasBearishFVG; // USER REQUEST: proximity no longer required

  const isBullish = currentCandle.close > currentCandle.open;
  const isBearish = currentCandle.close < currentCandle.open;
  const avgVolume = candles.length >= 20
    ? candles.slice(-20).reduce((acc, c) => acc + c.volume, 0) / 20
    : currentCandle.volume;
  const isVolumeSpike = currentCandle.volume >= avgVolume * Math.max(1, CONFIG.volumeMultiplier * 0.5); // USER REQUEST: relaxed from strict multiplier
  const rsiOk = features.rsiStrength >= 0.15 && features.rsiStrength <= 0.92; // USER REQUEST: less strict RSI
  const bbOk = true; // USER REQUEST: no longer strict BB filter
  const sweepBullish = features.liquiditySweep === 'BULLISH';
  const sweepBearish = features.liquiditySweep === 'BEARISH';

  const nearestResistanceRaw = swingHighsPrices.filter(h => h >= price);
  const nearestResistance = nearestResistanceRaw.length > 0 ? Math.min(...nearestResistanceRaw) : price + (isXAUUSD ? pointSize * 100 : pipSize * 50);
  const nearestSupportRaw = swingLowsPrices.filter(l => l <= price);
  const nearestSupport = nearestSupportRaw.length > 0 ? Math.max(...nearestSupportRaw) : price - (isXAUUSD ? pointSize * 100 : pipSize * 50);

  const buyStructureOk = isBullishStructure || sweepBullish;
  const sellStructureOk = isBearishStructure || sweepBearish;

  const buySoftReqs: GateResult[] = [
    { name: 'bullishSMC', passed: bullishSMC },
    { name: 'bullishPattern', passed: bullishPatternConfirm },
    { name: 'buyStructure', passed: buyStructureOk },
    { name: 'volumeSpike', passed: isVolumeSpike },
    { name: 'bullishCandle', passed: isBullish },
    { name: 'trendConfidence', passed: trendConfidenceOk || isBullishStructure || sweepBullish },
    { name: 'obOrFvgProximity', passed: obProximityOk || fvgProximityOk },
    { name: 'rsiFilter', passed: rsiOk },
    { name: 'bbFilter', passed: bbOk },
    { name: 'adxTrend', passed: (features.adxValue ?? 0) >= 10 }, // USER REQUEST: ATR/ADX less strict (was >=15)
    { name: 'sweepOrOB', passed: sweepBullish || hasBullishOB || hasBullishFVG || buyStructureOk },
    { name: 'similarWinrate', passed: true }, // USER REQUEST: removed strict winrate gate
  ];
  const buySoftPassed = buySoftReqs.filter(g => g.passed).length;

  const sellSoftReqs: GateResult[] = [
    { name: 'bearishSMC', passed: bearishSMC },
    { name: 'bearishPattern', passed: bearishPatternConfirm },
    { name: 'sellStructure', passed: sellStructureOk },
    { name: 'volumeSpike', passed: isVolumeSpike },
    { name: 'bearishCandle', passed: isBearish },
    { name: 'trendConfidence', passed: trendConfidenceOk || isBearishStructure || sweepBearish },
    { name: 'obOrFvgProximity', passed: obProximityOk || fvgProximityOk },
    { name: 'rsiFilter', passed: rsiOk },
    { name: 'bbFilter', passed: bbOk },
    { name: 'adxTrend', passed: (features.adxValue ?? 0) >= 10 }, // USER REQUEST: ATR/ADX less strict
    { name: 'sweepOrOB', passed: sweepBearish || hasBearishOB || hasBearishFVG || sellStructureOk },
    { name: 'similarWinrate', passed: true }, // USER REQUEST: removed strict winrate gate
  ];
  const sellSoftPassed = sellSoftReqs.filter(g => g.passed).length;

  const softThreshold = 2; // USER REQUEST: drastically lowered (was 5) so bot enters more often
  const structureOrTrendOk = trendConfidenceOk || sweepBullish || sweepBearish ||
    (features.structureStrength ?? 0) >= 0.25 || features.trendStrength >= 0.25 || buyStructureOk || sellStructureOk;

  let direction: "BUY" | "SELL" | null = null;
  if (hardGatesPassed >= hardGateThreshold && structureOrTrendOk) {
    const buySignal = buySoftPassed >= softThreshold;
    const sellSignal = sellSoftPassed >= softThreshold;
    if (buySignal && !sellSignal) {
      direction = 'BUY';
    } else if (sellSignal && !buySignal) {
      direction = 'SELL';
    } else if (buySignal && sellSignal) {
      const bsScore = buySoftPassed + (isBullishStructure ? 2 : 0) + (sweepBullish ? 2 : 0);
      const ssScore = sellSoftPassed + (isBearishStructure ? 2 : 0) + (sweepBearish ? 2 : 0);
      if (bsScore > ssScore + 1) direction = 'BUY';
      else if (ssScore > bsScore + 1) direction = 'SELL';
    }
  }

  if (!direction) return null;

  const activeRegime: MarketRegime = regime ?? (
    features.marketSession === 'ASIA' ? 'LOW_LIQUIDITY'
    : features.marketSession === 'OVERLAP' ? 'HIGH_LIQUIDITY'
    : features.volatility === 'EXTREME' ? 'VOLATILE'
    : features.trendStrength >= 0.6 ? 'TRENDING'
    : features.trendStrength <= 0.3 ? 'RANGING'
    : 'HIGH_LIQUIDITY'
  );
  const activeConf = Math.max(0.5, regimeConfidence || 0.6);

  const { stopLoss, tpLevels, slDistancePips } = calculateDynamicSLTP(
    direction, price, atr14, pipSize, pointSize, isXAUUSD,
    swingHighsPrices, swingLowsPrices, features, activeRegime, activeConf,
  );

  const riskParams: RiskParams = {
    accountBalance: balance,
    entryPrice: price,
    stopLoss,
    pipSize,
    pointSize,
    pipValue: payload.pipValue,
    minLot: payload.minLot,
    maxLot: payload.maxLot,
    minLotStep: payload.minLotStep,
    priorTarget: direction === "BUY" ? nearestResistance : nearestSupport,
    direction,
    spread,
  };

  const risk = calculateRisk(riskParams);
  const takeProfitLevels: number[] = risk.takeProfitLevels && risk.takeProfitLevels.length >= 3
    ? risk.takeProfitLevels
    : tpLevels;

  const tp1 = takeProfitLevels[0];
  // USER REQUEST: Removed minRiskRewardRatio gate entirely — no forced RR requirement

  let confidence = 60;
  confidence += Math.round((hardGatesPassed / hardGates.length) * 10);
  confidence += Math.round(((direction === 'BUY' ? buySoftPassed : sellSoftPassed) / 12) * 15);
  if (isVolumeSpike) confidence += 3;
  if (fvgProximityOk || obProximityOk) confidence += 4;
  if (features.similarSetupWinRate && features.similarSetupWinRate > 0) {
    confidence = Math.min(95, Math.max(60, Math.round(features.similarSetupWinRate * 100)));
  }
  confidence = Math.round(confidence * (0.6 + activeConf * 0.4));
  confidence = Math.min(95, Math.max(50, confidence));

  return {
    ...risk,
    takeProfitLevels,
    stopLoss,
    scaleInLevels: (risk.scaleInLevels || []).map(si => ({
      price: si.price,
      lotSize: si.lotSize,
      newStopLoss: si.newStopLoss,
      isRiskFree: si.isRiskFree,
    })),
    lotSizes: {
      entry1: risk.lotSizes?.entry1 || 0.01,
      entry2: risk.lotSizes?.entry2 || 0,
      entry3: risk.lotSizes?.entry3 || 0,
    },
    id: uuidv4(),
    symbol: payload.symbol,
    timeframe: payload.timeframe,
    confidence,
  } as TradeSignal;
};
