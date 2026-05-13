import { Decimal } from 'decimal.js';
import { CONFIG } from './tradingConfig';

/**
 * riskEngine.ts
 * Handles all lot size, risk distribution, and TP/SL level calculations.
 * Supports both Forex (Pips) and XAUUSD (Points).
 */

export interface RiskParams {
  accountBalance: number;
  entryPrice: number;
  stopLoss: number;
  pipSize: number;
  pointSize: number;
  pipValue: number; // Always live from MT5
  minLot: number;
  maxLot: number;
  minLotStep: number;
  priorTarget: number; // Prior Resistance (Long) or Next Swing Low (Short)
  direction: "BUY" | "SELL";
  spread: number;
}

export interface ScaleInLevel {
  price: number;
  lotSize: number;
  newStopLoss: number;
  isRiskFree: boolean;
}

export interface LotSizeMap {
  entry1: number;
  entry2: number;
  entry3: number;
}

export interface TradeSignal {
  id: string;
  symbol: string;
  direction: "BUY" | "SELL";
  entryPrice: number;
  stopLoss: number;
  takeProfitLevels: number[];      // [TP1, TP2, TP3]
  scaleInLevels: ScaleInLevel[];
  lotSizes: LotSizeMap;
  riskPercent: number;
  pipValue: number;
  timestamp: number;
  timeframe: string;
  confidence: number;
}

/**
 * Calculates all risk-related parameters for a trade signal.
 * @param params - The current account and symbol parameters.
 * @returns A structured TradeSignal object.
 */
export const calculateRisk = (params: RiskParams): Partial<TradeSignal> => {
  const {
    accountBalance,
    entryPrice,
    stopLoss,
    pipSize,
    pointSize,
    pipValue,
    minLot,
    maxLot,
    minLotStep,
    priorTarget,
    direction,
    spread
  } = params;

  const isBuy = direction === "BUY";
  const riskPercent = isBuy ? CONFIG.riskPercentPerTrade : 0.75; // 0.75 for short XAUUSD
  const totalRiskAmount = new Decimal(accountBalance).mul(riskPercent / 100);
  
  // Risk split: 50%, 30%, 20%
  const entry1Risk = totalRiskAmount.mul(0.50);
  const entry2Risk = totalRiskAmount.mul(0.30);
  const entry3Risk = totalRiskAmount.mul(0.20);

  let slDistance: Decimal;
  if (isBuy) {
    slDistance = new Decimal(entryPrice).sub(stopLoss).div(pipSize);
  } else {
    slDistance = new Decimal(stopLoss).sub(entryPrice).div(pointSize);
  }

  const calculateLots = (risk: Decimal): number => {
    if (slDistance.isZero()) return minLot;
    // lotSize = riskAmount / (stopLossDistance * pipValue)
    let lots = risk.div(slDistance.mul(pipValue));
    
    // Round down to broker's lot step
    const steps = lots.div(minLotStep).floor();
    lots = steps.mul(minLotStep);

    // Clamp between min and max
    if (lots.lt(minLot)) return minLot;
    if (lots.gt(maxLot)) return maxLot;
    return lots.toNumber();
  };

  const e1Lots = calculateLots(entry1Risk);
  const e2Lots = calculateLots(entry2Risk);
  const e3Lots = calculateLots(entry3Risk);

  let tp1: number, tp2: number, tp3: number;
  let si2Price: number, si2Stop: number;
  let si3Price: number, si3Stop: number;

  if (isBuy) {
    // LONG MATH
    tp1 = new Decimal(entryPrice).add(slDistance.mul(CONFIG.tp1RR).mul(pipSize)).toNumber();
    tp2 = new Decimal(entryPrice).add(slDistance.mul(CONFIG.tp2RR).mul(pipSize)).toNumber();
    tp3 = priorTarget;

    si2Price = new Decimal(entryPrice).add(new Decimal(tp1).sub(entryPrice).mul(CONFIG.scaleIn2PositionRatio)).toNumber();
    si2Stop = new Decimal(entryPrice).add(spread).toNumber(); // Breakeven

    si3Price = new Decimal(entryPrice).add(new Decimal(tp2).sub(entryPrice).mul(CONFIG.scaleIn3PositionRatio)).toNumber();
    si3Stop = new Decimal(si2Price).add(spread).toNumber(); // Lock ScaleIn2 profit
  } else {
    // SHORT MATH (XAUUSD points)
    tp1 = new Decimal(entryPrice).sub(slDistance.mul(CONFIG.tp1RR).mul(pointSize)).toNumber();
    tp2 = new Decimal(entryPrice).sub(slDistance.mul(CONFIG.tp2RR).mul(pointSize)).toNumber();
    tp3 = priorTarget;

    si2Price = new Decimal(entryPrice).sub(new Decimal(entryPrice).sub(tp1).mul(CONFIG.scaleIn2PositionRatio)).toNumber();
    si2Stop = new Decimal(entryPrice).sub(spread).toNumber(); // Breakeven short

    si3Price = new Decimal(entryPrice).sub(new Decimal(entryPrice).sub(tp2).mul(CONFIG.scaleIn3PositionRatio)).toNumber();
    si3Stop = new Decimal(si2Price).add(spread).toNumber(); // Lock ScaleIn2 profit
  }

  return {
    direction,
    entryPrice,
    stopLoss,
    takeProfitLevels: [tp1, tp2, tp3],
    lotSizes: {
      entry1: e1Lots,
      entry2: e2Lots,
      entry3: e3Lots
    },
    scaleInLevels: [
      { price: si2Price, lotSize: e2Lots, newStopLoss: si2Stop, isRiskFree: true },
      { price: si3Price, lotSize: e3Lots, newStopLoss: si3Stop, isRiskFree: true }
    ],
    riskPercent,
    pipValue,
    timestamp: Date.now()
  };
};
