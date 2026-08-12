import { CONFIG } from '../config/tradingConfig';
import { calculateRisk, RiskParams } from '../risk-manager/riskEngine';
import { TradeSignal, FeatureSet, Candle, MT5Payload } from '../types';
import { v4 as uuidv4 } from 'uuid';

/**
 * signalValidator.ts
 * Validates incoming MT5 data against SMC reversal entry rules (OB/FVG + candlestick patterns).
 * Strictly gates on Smart Money Concepts zones confirmed by price action patterns.
 */

// --- UTILITY CALCULATION FUNCTIONS ---

/** Calculate ATR (Average True Range) for given candles and period.
 * Candles are assumed to be in chronological-ascending order (oldest first),
 * matching feature-engineering/featureEngine.ts::calculateATR.
 */
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

/**
 * Determine the current forex trading session purely from server UTC time.
 * Approximate session hours (UTC): Asia 00:00-09:00, London 08:00-17:00,
 * New York 13:00-22:00. Overlap = London & New York both active.
 */
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

/** Calculate swing highs (lookback N candles) */
export const calculateSwingHighs = (candles: Candle[], lookback: number = 2): number[] => {
  const swingHighs: number[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const isSwingHigh = candles.slice(i - lookback, i).every(c => c.high < candles[i].high) &&
                        candles.slice(i + 1, i + lookback + 1).every(c => c.high < candles[i].high);
    if (isSwingHigh) swingHighs.push(candles[i].high);
  }
  return swingHighs;
};

/** Calculate swing lows (lookback N candles) */
export const calculateSwingLows = (candles: Candle[], lookback: number = 2): number[] => {
  const swingLows: number[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const isSwingLow = candles.slice(i - lookback, i).every(c => c.low > candles[i].low) &&
                       candles.slice(i + 1, i + lookback + 1).every(c => c.low > candles[i].low);
    if (isSwingLow) swingLows.push(candles[i].low);
  }
  return swingLows;
};

/** Calculate Exponential Moving Average (EMA) */
export const calculateEMA = (candles: Candle[], period: number): number => {
  if (candles.length < period) return 0;
  const k = 2 / (period + 1);
  let ema = candles.slice(candles.length - period, candles.length).reduce((a, c) => a + c.close, 0) / period;
  for (let i = candles.length - period - 1; i >= 0; i--) {
    ema = candles[i].close * k + ema * (1 - k);
  }
  return ema;
};

/**
 * Validates trade signals using strict SMC gating:
 *   1. Order Block or FVG zone must align with proposed direction
 *   2. Confirmation candlestick pattern required (HAMMER/PIN_BAR/ENGULFING)
 *   3. Trend/structure alignment check
 *
 * @param payload - MT5 data packet
 * @param features - Pre-computed FeatureSet from the feature engineering pipeline
 * @returns TradeSignal or null if SMC conditions are not met
 */
export const validateSignal = (payload: MT5Payload, features?: FeatureSet): TradeSignal | null => {
  const {
    symbol, candles, spread, balance, equity, pipSize, pointSize,
    ema20, ema20Prev, newsFilterActive,
    openPositionsCount
  } = payload;

  const N = CONFIG.reversalCandleCount;
  if (candles.length < N + 1) return null;

  const atr14 = payload.atr14 !== undefined ? payload.atr14 : calculateATR(candles, 14);
  const swingHighs = payload.swingHighs !== undefined ? payload.swingHighs : calculateSwingHighs(candles);
  const swingLows = payload.swingLows !== undefined ? payload.swingLows : calculateSwingLows(candles);

  const currentCandle = candles[candles.length - 1];
  const priorCandle = candles[candles.length - 2];
  const price = currentCandle.close;
  const isXAUUSD = symbol.includes("XAU") || symbol.includes("GOLD");

  // --- SANITY FILTERS (always checked) ---
  const drawdown = balance > 0 ? ((balance - equity) / balance) * 100 : 0;
  if (drawdown > CONFIG.maxDrawdownPercent) return null;

  const maxOpen = isXAUUSD ? 2 : CONFIG.maxOpenTrades;
  if (openPositionsCount >= maxOpen) return null;

  const maxSpread = isXAUUSD ? CONFIG.maxSpreadPoints * pointSize : CONFIG.maxSpreadPips * pipSize;
  if (spread > maxSpread) return null;

  const timezoneTradingEnabled = payload.timezoneTradingEnabled !== false;
  const currentSession = getCurrentSession();
  if (timezoneTradingEnabled && CONFIG.blockedSessions.includes(currentSession)) return null;

  if (payload.marginLevel !== undefined && payload.marginLevel < CONFIG.minMarginLevelPercent) {
    return null;
  }

  if (payload.dailyLossPercent !== undefined && payload.dailyLossPercent >= CONFIG.maxDailyLossPercent) {
    return null;
  }

  if (newsFilterActive) return null;

  // --- SMC PRIMARY GATE: requires pre-computed features ---
  if (!features) return null;

  const isBullishStructure = features.trendDirection === 'BULLISH';
  const isBearishStructure = features.trendDirection === 'BEARISH';

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

  // --- FVG / OB proximity to current price ---
  const fvgDetails = features.fvgDetails;
  const obDetails = features.orderBlockDetails;

  let fvgProximityOk = false;
  if (fvgDetails && fvgDetails.type !== 'NONE') {
    const midpoint = (fvgDetails.startPrice + fvgDetails.endPrice) / 2;
    const gapSize = Math.abs(fvgDetails.endPrice - fvgDetails.startPrice);
    const tolerance = Math.max(gapSize, pipSize * 5);
    fvgProximityOk = Math.abs(price - midpoint) <= tolerance;
  }

  let obProximityOk = false;
  if (obDetails && obDetails.type !== 'NONE') {
    const obTop = obDetails.top;
    const obBottom = obDetails.bottom;
    const isWithinOB = price >= Math.min(obTop, obBottom) && price <= Math.max(obTop, obBottom);
    const obSize = Math.abs(obTop - obBottom);
    const tolerance = Math.max(obSize, pipSize * 3);
    const isNearOB = price >= Math.min(obTop, obBottom) - tolerance && price <= Math.max(obTop, obBottom) + tolerance;
    obProximityOk = isWithinOB || isNearOB;
  }

  const bullishSMC =
    (hasBullishOB && obProximityOk) ||
    (hasBullishFVG && fvgProximityOk);

  const bearishSMC =
    (hasBearishOB && obProximityOk) ||
    (hasBearishFVG && fvgProximityOk);

  // --- Additional basic confirmation (price action from candles) ---
  const isBullish = currentCandle.close > currentCandle.open;
  const isBearish = currentCandle.close < currentCandle.open;
  const avgVolume = candles.length >= 20
    ? candles.slice(-20).reduce((acc, c) => acc + c.volume, 0) / 20
    : currentCandle.volume;
  const isVolumeSpike = currentCandle.volume >= avgVolume * CONFIG.volumeMultiplier;

  let direction: "BUY" | "SELL" | null = null;

  // --- STRICT SMC BUY GATE ---
  const nearestResistanceRaw = swingHighs.filter(h => h >= price);
  const nearestResistance = nearestResistanceRaw.length > 0
    ? Math.min(...nearestResistanceRaw)
    : price + (isXAUUSD ? pointSize * 100 : pipSize * 50);
  const nearestSupportRaw = swingLows.filter(l => l <= price);
  const nearestSupport = nearestSupportRaw.length > 0
    ? Math.max(...nearestSupportRaw)
    : price - (isXAUUSD ? pointSize * 100 : pipSize * 50);

  const buyStructureOk = isBullishStructure || features.liquiditySweep === 'BULLISH';
  if (
    isBullish &&
    bullishSMC &&
    bullishPatternConfirm &&
    buyStructureOk &&
    isVolumeSpike
  ) {
    direction = "BUY";
  }

  // --- STRICT SMC SELL GATE ---
  const sellStructureOk = isBearishStructure || features.liquiditySweep === 'BEARISH';
  if (
    !direction &&
    isBearish &&
    bearishSMC &&
    bearishPatternConfirm &&
    sellStructureOk &&
    isVolumeSpike
  ) {
    direction = "SELL";
  }

  if (!direction) return null;

  // --- RISK CALCULATION ---
  let stopLoss: number;
  if (direction === "BUY") {
    if (obDetails && hasBullishOB) {
      stopLoss = Math.min(obDetails.bottom, priorCandle.low) - (CONFIG.spreadBuffer * pipSize);
    } else if (fvgDetails && hasBullishFVG) {
      stopLoss = fvgDetails.startPrice - (CONFIG.spreadBuffer * pipSize);
    } else {
      stopLoss = priorCandle.low - (CONFIG.spreadBuffer * pipSize);
    }
  } else {
    if (CONFIG.useAtrStop && isXAUUSD) {
      stopLoss = currentCandle.high + (atr14 * CONFIG.atrMultiplier) + (CONFIG.spreadBuffer * pointSize);
    } else if (obDetails && hasBearishOB) {
      stopLoss = Math.max(obDetails.top, priorCandle.high) + (CONFIG.spreadBuffer * pointSize);
    } else if (fvgDetails && hasBearishFVG) {
      stopLoss = fvgDetails.startPrice + (CONFIG.spreadBuffer * pointSize);
    } else {
      stopLoss = priorCandle.high + (CONFIG.spreadBuffer * pointSize);
    }
  }

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
    spread
  };

  const risk = calculateRisk(riskParams);

  const tp1 = risk.takeProfitLevels?.[0];
  if (tp1 !== undefined) {
    const riskDistance = Math.abs(price - stopLoss);
    const rewardDistance = Math.abs(tp1 - price);
    const rrRatio = riskDistance === 0 ? 0 : rewardDistance / riskDistance;
    if (rrRatio < CONFIG.minRiskRewardRatio) return null;
  }

  // --- Pattern confidence scoring ---
  let confidence = 60;
  if (bullishPatternConfirm || bearishPatternConfirm) confidence += 10;
  if (isVolumeSpike) confidence += 5;
  if (fvgProximityOk || obProximityOk) confidence += 5;
  if (features.similarSetupWinRate && features.similarSetupWinRate > 0) {
    confidence = Math.min(95, Math.max(60, Math.round(features.similarSetupWinRate * 100)));
  }
  confidence = Math.min(95, confidence);

  return {
    ...risk,
    takeProfitLevels: risk.takeProfitLevels || [],
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
