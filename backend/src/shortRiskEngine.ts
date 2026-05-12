import { Decimal } from 'decimal.js';
import { XAUUSD_CONFIG } from './xauusdConfig';

/**
 * shortRiskEngine.ts
 * Handles risk math for XAUUSD SHORT trades.
 * Specifically designed for Sell orders where SL is above Entry.
 */

export interface ShortRiskParams {
  accountBalance: number;
  entryPrice: number;
  stopLoss: number;
  pointSize: number;
  pipValue: number; // live from MT5 SymbolInfoDouble(SYMBOL_TRADE_TICK_VALUE)
  minLot: number;
  maxLot: number;
  minLotStep: number;
  nextMajorSwingLow: number;
}

export interface CalculatedShortRisk {
  entry1: { lotSize: number; riskAmount: number };
  entry2: { lotSize: number; riskAmount: number };
  entry3: { lotSize: number; riskAmount: number };
  tp1: number;
  tp2: number;
  tp3: number;
  stopLossPoints: number;
  scaleIn2: { price: number; newStop: number };
  scaleIn3: { price: number; newStop: number };
}

/**
 * Calculates risk parameters for a Gold SHORT signal.
 */
export const calculateShortRisk = (params: ShortRiskParams): CalculatedShortRisk => {
  const {
    accountBalance,
    entryPrice,
    stopLoss,
    pointSize,
    pipValue,
    minLot,
    maxLot,
    minLotStep,
    nextMajorSwingLow
  } = params;

  // 1. Calculate Risk Amounts (0.75% total split 50/30/20)
  const totalRiskAmount = new Decimal(accountBalance).mul(XAUUSD_CONFIG.riskPercentPerTrade / 100);
  const entry1Risk = totalRiskAmount.mul(0.5);
  const entry2Risk = totalRiskAmount.mul(0.3);
  const entry3Risk = totalRiskAmount.mul(0.2);

  // 2. Calculate Stop Loss Points (SL is ABOVE entry for shorts)
  const stopLossPoints = new Decimal(stopLoss).sub(entryPrice).abs().div(pointSize);

  // 3. Calculate Lot Sizes
  const calculateLots = (risk: Decimal): number => {
    // lotSize = riskAmount / (stopLossPoints * pipValue)
    if (stopLossPoints.isZero()) return minLot;
    
    let lots = risk.div(stopLossPoints.mul(pipValue));
    
    const steps = lots.div(minLotStep).floor();
    lots = steps.mul(minLotStep);

    if (lots.lt(minLot)) return minLot;
    if (lots.gt(maxLot)) return maxLot;
    return lots.toNumber();
  };

  const entry1Lots = calculateLots(entry1Risk);
  const entry2Lots = calculateLots(entry2Risk);
  const entry3Lots = calculateLots(entry3Risk);

  // 4. Calculate Take Profit Levels (Downward targets)
  // TP1 = entryPrice - (stopLossPoints * 1.5) * pointSize
  const tp1 = new Decimal(entryPrice).sub(stopLossPoints.mul(XAUUSD_CONFIG.tp1RR).mul(pointSize)).toNumber();
  // TP2 = entryPrice - (stopLossPoints * 3.0) * pointSize
  const tp2 = new Decimal(entryPrice).sub(stopLossPoints.mul(XAUUSD_CONFIG.tp2RR).mul(pointSize)).toNumber();
  // TP3 = Swing Low
  const tp3 = nextMajorSwingLow;

  // 5. Calculate Scale-In Trigger Levels (Below entry)
  // ScaleIn2: 40% of the way to TP1
  const si2Price = new Decimal(entryPrice).sub(new Decimal(entryPrice).sub(tp1).mul(XAUUSD_CONFIG.scaleIn2PositionRatio)).toNumber();
  // ScaleIn3: 55% of the way to TP2
  const si3Price = new Decimal(entryPrice).sub(new Decimal(entryPrice).sub(tp2).mul(XAUUSD_CONFIG.scaleIn3PositionRatio)).toNumber();

  const spread = 0.0035; // Approx 35 points for XAUUSD buffer

  return {
    entry1: { lotSize: entry1Lots, riskAmount: entry1Risk.toNumber() },
    entry2: { lotSize: entry2Lots, riskAmount: entry2Risk.toNumber() },
    entry3: { lotSize: entry3Lots, riskAmount: entry3Risk.toNumber() },
    tp1,
    tp2,
    tp3,
    stopLossPoints: stopLossPoints.toNumber(),
    scaleIn2: {
      price: si2Price,
      newStop: entryPrice - spread // Move stop down to breakeven
    },
    scaleIn3: {
      price: si3Price,
      newStop: si2Price + spread // Lock in si2 profits
    }
  };
};
