import { CONFIG } from './tradingConfig';
import { calculateRisk, RiskParams, TradeSignal } from './riskEngine';
import { v4 as uuidv4 } from 'uuid';

/**
 * signalValidator.ts
 * Validates incoming MT5 data against reversal entry rules and emits signals.
 */

export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
  x?: number;
}

export interface MT5Payload {
  symbol: string;
  timeframe: string;
  candles: Candle[]; // Last N candles
  spread: number;
  balance: number;
  equity: number;
  pipSize: number;
  pointSize: number;
  pipValue: number;
  minLot: number;
  maxLot: number;
  minLotStep: number;
  swingHighs?: number[]; // pre-calculated swing highs
  swingLows?: number[]; // pre-calculated swing lows
  openPositionsCount: number;
  ema20: number;
  ema20Prev: number;
  atr14?: number;
  newsFilterActive?: boolean;
  positions?: any[];
  openPositions?: any[];
}

// --- UTILITY CALCULATION FUNCTIONS ---

/** Calculate ATR (Average True Range) for given candles and period */
export const calculateATR = (candles: Candle[], period: number = 14): number => {
  if (candles.length <= period) return 0;
  const trs: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    if (i === candles.length - 1) {
      trs.push(candles[i].high - candles[i].low);
    } else {
      const prev = candles[i + 1];
      const trueRange = Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - prev.close),
        Math.abs(candles[i].low - prev.close)
      );
      trs.push(trueRange);
    }
  }
  const atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  return atr;
};

/** Calculate swing highs (lookback N candles) */
export const calculateSwingHighs = (candles: Candle[], lookback: number = 2): number[] => {
  const swingHighs: number[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const isSwingHigh = candles[i].high > candles.slice(i - lookback, i).every(c => c.high < candles[i].high) &&
                        candles[i].high > candles.slice(i + 1, i + lookback + 1).every(c => c.high < candles[i].high);
    if (isSwingHigh) swingHighs.push(candles[i].high);
  }
  return swingHighs;
};

/** Calculate swing lows (lookback N candles) */
export const calculateSwingLows = (candles: Candle[], lookback: number = 2): number[] => {
  const swingLows: number[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const isSwingLow = candles[i].low < candles.slice(i - lookback, i).every(c => c.low > candles[i].low) &&
                       candles[i].low < candles.slice(i + 1, i + lookback + 1).every(c => c.low > candles[i].low);
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
 * JSDoc: Validates trade signals based on complex SMC and momentum rules.
 * @param payload - The data packet from MT5.
 * @returns TradeSignal or null if conditions are not met.
 */
export const validateSignal = (payload: MT5Payload): TradeSignal | null => {
  const { 
    symbol, candles, spread, balance, equity, pipSize, pointSize,
    ema20, ema20Prev, atr14, newsFilterActive,
    openPositionsCount, swingHighs, swingLows
  } = payload;
  
  const N = CONFIG.reversalCandleCount;
  if (candles.length < N + 1) return null;

  const currentCandle = candles[candles.length - 1];
  const priorCandle = candles[candles.length - 2];
  const price = currentCandle.close;
  const isXAUUSD = symbol.includes("XAU") || symbol.includes("GOLD");

  // 1. Drawdown Check
  const drawdown = ((balance - equity) / balance) * 100;
  if (drawdown > CONFIG.maxDrawdownPercent) return null;

  // 2. Open Trades Limit
  const maxOpen = isXAUUSD ? 2 : CONFIG.maxOpenTrades;
  if (openPositionsCount >= maxOpen) return null;

  // 3. Spread Filter
  const maxSpread = isXAUUSD ? CONFIG.maxSpreadPoints * pointSize : CONFIG.maxSpreadPips * pipSize;
  if (spread > maxSpread) return null;

  let direction: "BUY" | "SELL" | null = null;

  // --- BUY CONDITIONS ---
  const isBullish = currentCandle.close > currentCandle.open;
  const isLowestLow = priorCandle.low === Math.min(...candles.slice(-(N+1), -1).map(c => c.low));
  const closesAboveMidpoint = currentCandle.close > (priorCandle.open + priorCandle.close) / 2;
  const isEngulfingBull = currentCandle.close > priorCandle.high && currentCandle.open < priorCandle.low;
  const bodySizePips = Math.abs(currentCandle.close - currentCandle.open) / pipSize;
  const isBodyLargeEnoughLong = bodySizePips >= CONFIG.minCandleBodyPips;
  
  const avgVolume = candles.slice(-20).reduce((acc, c) => acc + c.volume, 0) / 20;
  const isVolumeSpike = currentCandle.volume >= avgVolume * CONFIG.volumeMultiplier;
  
  const nearestSupport = Math.max(...swingLows.filter(l => l <= price));
  const isNearSupport = (price - nearestSupport) / pipSize <= CONFIG.supportProximityPips;

  if (
    isBullish && isLowestLow && (closesAboveMidpoint || isEngulfingBull) &&
    isBodyLargeEnoughLong && isVolumeSpike && isNearSupport
  ) {
    direction = "BUY";
  }

  // --- SELL CONDITIONS (XAUUSD Focus) ---
  const isBearish = currentCandle.close < currentCandle.open;
  const isHighestHigh = priorCandle.high === Math.max(...candles.slice(-(N+1), -1).map(c => c.high));
  const isBelowEma = price < ema20;
  const isEmaSlopingDown = ema20 < ema20Prev;
  const closesBelowMidpoint = currentCandle.close < (priorCandle.open + priorCandle.close) / 2;
  const isEngulfingBear = currentCandle.close < priorCandle.low && currentCandle.open > priorCandle.high;
  const upperWick = currentCandle.high - Math.max(currentCandle.open, currentCandle.close);
  const candleBody = Math.abs(currentCandle.close - currentCandle.open);
  const isShootingStar = upperWick >= 2 * candleBody;
  
  const bodySizePoints = candleBody / pointSize;
  const isBodyLargeEnoughShort = isXAUUSD ? bodySizePoints >= CONFIG.minCandleBodyPoints : bodySizePips >= CONFIG.minCandleBodyPips;

  const nearestResistance = Math.min(...swingHighs.filter(h => h >= price));
  const isNearResistance = isXAUUSD 
    ? (nearestResistance - price) / pointSize <= CONFIG.resistanceProximityPoints
    : (nearestResistance - price) / pipSize <= CONFIG.supportProximityPips;

  if (
    !direction && isBearish && isHighestHigh && isBelowEma && isEmaSlopingDown &&
    (closesBelowMidpoint || isEngulfingBear || isShootingStar) &&
    isBodyLargeEnoughShort && isVolumeSpike && isNearResistance && !newsFilterActive
  ) {
    direction = "SELL";
  }

  if (!direction) return null;

  // --- SUCCESS: CALCULATE RISK ---
  let stopLoss: number;
  if (direction === "BUY") {
    stopLoss = priorCandle.low;
  } else {
    // ATR STOP (XAUUSD)
    if (CONFIG.useAtrStop) {
      stopLoss = currentCandle.high + (atr14 * CONFIG.atrMultiplier) + (CONFIG.spreadBuffer * pointSize);
    } else {
      stopLoss = priorCandle.high;
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

  return {
    ...risk,
    id: uuidv4(),
    symbol: payload.symbol,
    timeframe: payload.timeframe,
    confidence: 85 // Base confidence for meeting all rules
  } as TradeSignal;
};
