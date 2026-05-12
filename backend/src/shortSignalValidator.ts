import { XAUUSD_CONFIG } from './xauusdConfig';
import { calculateShortRisk, ShortRiskParams } from './shortRiskEngine';
import { v4 as uuidv4 } from 'uuid';

/**
 * shortSignalValidator.ts
 * Validates XAUUSD SHORT entry conditions.
 */

export interface ShortCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
}

export interface ShortMT5Payload {
  symbol: "XAUUSD";
  candles: ShortCandle[];
  ema20: number;
  emaSlopingDown: boolean;
  spread: number;
  balance: number;
  equity: number;
  pipValue: number;
  minLot: number;
  maxLot: number;
  minLotStep: number;
  swingHighs: number[]; // Resistance
  swingLows: number[];  // Support/TP3
  openPositionsCount: number;
  newsFilterActive: boolean;
  atr14: number;
}

export const validateShortSignal = (payload: ShortMT5Payload) => {
  const { candles, spread, balance, equity, emaSlopingDown, ema20, swingHighs, swingLows, openPositionsCount, newsFilterActive } = payload;
  const pointSize = XAUUSD_CONFIG.pointSize;

  if (candles.length < XAUUSD_CONFIG.reversalCandleCount + 1) return null;

  const current = candles[candles.length - 1];
  const prior = candles[candles.length - 2];
  const lookback = candles.slice(-(XAUUSD_CONFIG.reversalCandleCount + 1), -1);

  // 1. DOWNTREND CONFIRMATION
  const highestHigh = Math.max(...lookback.map(c => c.high));
  if (prior.high < highestHigh) return null; // Rally must hit a peak
  if (current.close >= current.open) return null; // Must close bearish
  if (current.close > ema20 || !emaSlopingDown) return null; // Must be under sloping EMA

  // 2. REVERSAL PATTERN
  const priorMidpoint = prior.low + (prior.open - prior.low) / 2;
  const isMidpointClose = current.close < priorMidpoint;
  const isEngulfing = current.close < prior.open && current.open > prior.close;
  const isShootingStar = (current.high - Math.max(current.open, current.close)) >= Math.abs(current.open - current.close) * 2;

  if (!isMidpointClose && !isEngulfing && !isShootingStar) return null;

  const bodyPoints = Math.abs(current.open - current.close) / pointSize;
  if (bodyPoints < XAUUSD_CONFIG.minCandleBodyPoints) return null;

  // 3. VOLUME CONFIRMATION
  const avgVol = candles.slice(-20).reduce((acc, c) => acc + c.volume, 0) / 20;
  if (current.volume < avgVol * XAUUSD_CONFIG.volumeMultiplier) return null;

  // 4. RESISTANCE PROXIMITY
  const nearestResistance = Math.min(...swingHighs.map(lvl => Math.abs(current.high - lvl)));
  if (nearestResistance > XAUUSD_CONFIG.resistanceProximityPoints * pointSize) return null;

  // 5. SPREAD & SAFETY
  if (spread > XAUUSD_CONFIG.maxSpreadPoints) return null;
  if (newsFilterActive) return null;
  const drawdown = (balance - equity) / balance * 100;
  if (drawdown > XAUUSD_CONFIG.maxDrawdownPercent) return null;
  if (openPositionsCount >= XAUUSD_CONFIG.maxOpenTrades) return null;

  // 6. CALCULATE & RETURN
  const stopLoss = XAUUSD_CONFIG.useAtrStop 
    ? current.high + (payload.atr14 * XAUUSD_CONFIG.atrMultiplier)
    : highestHigh + (spread * pointSize);

  const riskParams: ShortRiskParams = {
    accountBalance: balance,
    entryPrice: current.close,
    stopLoss,
    pointSize,
    pipValue: payload.pipValue,
    minLot: payload.minLot,
    maxLot: payload.maxLot,
    minLotStep: payload.minLotStep,
    nextMajorSwingLow: swingLows[0] || current.close - (500 * pointSize)
  };

  const risk = calculateShortRisk(riskParams);

  return {
    id: uuidv4(),
    symbol: "XAUUSD",
    direction: "SELL",
    entryPrice: riskParams.entryPrice,
    stopLoss: riskParams.stopLoss,
    tpLevels: [risk.tp1, risk.tp2, risk.tp3],
    scaleInLevels: [risk.scaleIn2, risk.scaleIn3],
    lotSizes: {
      entry1: risk.entry1.lotSize,
      entry2: risk.entry2.lotSize,
      entry3: risk.entry3.lotSize
    },
    riskPercent: XAUUSD_CONFIG.riskPercentPerTrade,
    timestamp: Date.now(),
    confidence: 100
  };
};
