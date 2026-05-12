import { Decimal } from 'decimal.js';
import { CONFIG } from './tradingConfig';

/**
 * riskEngine.ts
 * Handles all lot size, risk distribution, and TP/SL level calculations.
 */

export interface RiskParams {
  accountBalance: number;
  entryPrice: number;
  stopLoss: number;
  pipSize: number;
  contractSize: number;
  accountCurrencyExchangeRate: number; // Rate to convert symbol profit to account currency
  minLot: number;
  maxLot: number;
  minLotStep: number;
  priorResistanceLevel: number;
}

export interface CalculatedRisk {
  entry1: { lotSize: number; riskAmount: number };
  entry2: { lotSize: number; riskAmount: number };
  entry3: { lotSize: number; riskAmount: number };
  tp1: number;
  tp2: number;
  tp3: number;
  stopLossPips: number;
  scaleIn2: { price: number; newStop: number };
  scaleIn3: { price: number; newStop: number };
}

/**
 * Calculates all risk-related parameters for a trade signal.
 * @param params - The current account and symbol parameters.
 * @returns A structured object containing lot sizes, TP levels, and scale-in triggers.
 */
export const calculateRisk = (params: RiskParams): CalculatedRisk => {
  const {
    accountBalance,
    entryPrice,
    stopLoss,
    pipSize,
    contractSize,
    accountCurrencyExchangeRate,
    minLot,
    maxLot,
    minLotStep,
    priorResistanceLevel
  } = params;

  // 1. Calculate Risk Amounts (1.0% total split 50/30/20)
  const totalRiskAmount = new Decimal(accountBalance).mul(CONFIG.riskPercentPerTrade / 100);
  const entry1Risk = totalRiskAmount.mul(0.5);
  const entry2Risk = totalRiskAmount.mul(0.3);
  const entry3Risk = totalRiskAmount.mul(0.2);

  // 2. Calculate Pip Value and SL Distance
  const stopLossPips = new Decimal(entryPrice).sub(stopLoss).abs().div(pipSize);
  
  // pipValue = (contract size * pip size) / exchange rate
  const pipValue = new Decimal(contractSize).mul(pipSize).div(accountCurrencyExchangeRate);

  // 3. Calculate Lot Sizes
  const calculateLots = (risk: Decimal): number => {
    // lotSize = riskAmount / (stopLossPips * pipValue)
    let lots = risk.div(stopLossPips.mul(pipValue));
    
    // Round down to broker's lot step
    const steps = lots.div(minLotStep).floor();
    lots = steps.mul(minLotStep);

    // Clamp between min and max
    if (lots.lt(minLot)) return minLot;
    if (lots.gt(maxLot)) return maxLot;
    return lots.toNumber();
  };

  const entry1Lots = calculateLots(entry1Risk);
  const entry2Lots = calculateLots(entry2Risk);
  const entry3Lots = calculateLots(entry3Risk);

  // 4. Calculate Take Profit Levels
  // TP1 = entryPrice + (stopLossPips * 1.5) * pipSize
  const tp1 = new Decimal(entryPrice).add(stopLossPips.mul(CONFIG.tp1RR).mul(pipSize)).toNumber();
  // TP2 = entryPrice + (stopLossPips * 3.0) * pipSize
  const tp2 = new Decimal(entryPrice).add(stopLossPips.mul(CONFIG.tp2RR).mul(pipSize)).toNumber();
  // TP3 = Prior Resistance (Swing High)
  const tp3 = priorResistanceLevel;

  // 5. Calculate Scale-In Trigger Levels
  // ScaleIn2: 40% of the way to TP1
  const si2Price = new Decimal(entryPrice).add(new Decimal(tp1).sub(entryPrice).mul(CONFIG.scaleIn2PositionRatio)).toNumber();
  // ScaleIn3: 55% of the way to TP2
  const si3Price = new Decimal(entryPrice).add(new Decimal(tp2).sub(entryPrice).mul(CONFIG.scaleIn3PositionRatio)).toNumber();

  return {
    entry1: { lotSize: entry1Lots, riskAmount: entry1Risk.toNumber() },
    entry2: { lotSize: entry2Lots, riskAmount: entry2Risk.toNumber() },
    entry3: { lotSize: entry3Lots, riskAmount: entry3Risk.toNumber() },
    tp1,
    tp2,
    tp3,
    stopLossPips: stopLossPips.toNumber(),
    scaleIn2: {
      price: si2Price,
      newStop: entryPrice // Move stop to entry 1 breakeven
    },
    scaleIn3: {
      price: si3Price,
      newStop: si2Price // Lock in scale-in 2 profits
    }
  };
};
