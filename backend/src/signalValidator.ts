import { CONFIG } from './tradingConfig';
import { calculateRisk, RiskParams, CalculatedRisk } from './riskEngine';
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
}

export interface MT5Payload {
  symbol: string;
  timeframe: string;
  candles: Candle[]; // Last N candles
  spread: number;
  balance: number;
  equity: number;
  margin: number;
  pipSize: number;
  contractSize: number;
  exchangeRate: number;
  minLot: number;
  maxLot: number;
  minLotStep: number;
  supportLevels: number[]; // pre-calculated swing lows
  resistanceLevels: number[]; // pre-calculated swing highs
  openPositionsCount: number;
  // --- Scalping Additions ---
  ema5: number;
  ema10: number;
  ema20: number;
  stochK: number;
  stochD: number;
  cci: number;
  sar: number;
}

export interface TradeSignal {
  id: string;
  symbol: string;
  direction: "BUY" | "SELL";
  entryPrice: number;
  stopLoss: number;
  tpLevels: number[];
  scaleInLevels: any[];
  lotSizes: { entry1: number; entry2: number; entry3: number };
  riskPercent: number;
  timestamp: number;
  confidence: number;
}

/**
 * Aggressive Scalper Validation
 */
export const validateSignal = (payload: MT5Payload): TradeSignal | null => {
  const { 
    candles, spread, balance, equity, pipSize, 
    ema5, ema10, ema20, stochK, stochD, cci, sar, 
    openPositionsCount 
  } = payload;
  
  if (candles.length < 20) return null;

  const currentCandle = candles[candles.length - 1];
  const price = currentCandle.close;

  // --- 1. AGGRESSIVE TREND CONFIRMATION ---
  // Fast EMA Stack: 5 > 10 > 20 for BUY
  const isEmaBullish = ema5 > ema10 && ema10 > ema20;
  const isEmaBearish = ema5 < ema10 && ema10 < ema20;
  
  // Parabolic SAR confirmation
  const isSarBullish = price > sar;
  const isSarBearish = price < sar;

  // --- 2. MOMENTUM CONFIRMATION ---
  // Stochastic Oversold/Overbought Hook
  const isStochBullish = stochK > stochD && stochK < 40;
  const isStochBearish = stochK < stochD && stochK > 60;
  
  // CCI Zero-Line Cross
  const isCciBullish = cci > 0;
  const isCciBearish = cci < 0;

  let direction: "BUY" | "SELL" | null = null;
  if (isEmaBullish && isSarBullish && (isStochBullish || isCciBullish)) direction = "BUY";
  else if (isEmaBearish && isSarBearish && (isStochBearish || isCciBearish)) direction = "SELL";

  if (!direction) return null;

  // --- 3. VOLUME & BODY SENSITIVITY ---
  const bodySizePips = Math.abs(currentCandle.close - currentCandle.open) / pipSize;
  if (bodySizePips < (CONFIG as any).minCandleBodyPips) return null;

  const avgVolume = candles.slice(-10).reduce((acc, c) => acc + c.volume, 0) / 10;
  if (currentCandle.volume < avgVolume * (CONFIG as any).volumeMultiplier) return null;

  // --- 4. SAFETY & LIMITS ---
  if (spread > (CONFIG as any).maxSpreadPips * pipSize) return null;
  if (openPositionsCount >= (CONFIG as any).maxOpenTrades) return null;
  
  const drawdown = (balance - equity) / balance * 100;
  if (drawdown > (CONFIG as any).maxDrawdownPercent) return null;

  // --- SUCCESS: CALCULATE AGGRESSIVE RISK ---
  const isBuy = direction === "BUY";
  const stopLoss = isBuy 
    ? price - ((CONFIG as any).stopLossPips * pipSize)
    : price + ((CONFIG as any).stopLossPips * pipSize);

  const riskParams: RiskParams = {
    accountBalance: balance,
    entryPrice: price,
    stopLoss,
    pipSize,
    contractSize: payload.contractSize,
    accountCurrencyExchangeRate: payload.exchangeRate,
    minLot: payload.minLot,
    maxLot: payload.maxLot,
    minLotStep: payload.minLotStep,
    priorResistanceLevel: isBuy ? price + (15 * pipSize) : price - (15 * pipSize)
  };

  const risk = calculateRisk(riskParams);

  return {
    id: uuidv4(),
    symbol: payload.symbol,
    direction,
    entryPrice: price,
    stopLoss,
    tpLevels: isBuy 
      ? [price + (5 * pipSize), price + (10 * pipSize), price + (15 * pipSize)]
      : [price - (5 * pipSize), price - (10 * pipSize), price - (15 * pipSize)],
    scaleInLevels: [], 
    lotSizes: {
      entry1: risk.entry1.lotSize,
      entry2: risk.entry2.lotSize,
      entry3: risk.entry3.lotSize
    },
    riskPercent: (CONFIG as any).riskPercentPerTrade,
    timestamp: Date.now(),
    confidence: 100
  };
};
