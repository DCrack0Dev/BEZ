import { CONFIG } from './tradingConfig';
import { Decimal } from 'decimal.js';

/**
 * trailingStopManager.ts
 * Manages trailing stop phases (1-5) and scale-in triggers for both directions.
 * Ensures stops only move in the profit direction (idempotent).
 */

export interface PositionState {
  ticket: string;
  signalId: string;
  symbol: string;
  direction: 'BUY' | 'SELL';
  openPrice: number;
  currentSL: number;
  currentPrice: number;
  phase: 1 | 2 | 3 | 4 | 5;
  scaleInLevels: { price: number; newStopLoss: number }[];
  tpLevels: number[];
  spread: number;
  pipSize: number;
  pointSize: number;
}

/**
 * JSDoc: Manages the 5-phase trailing stop logic for a position.
 * @param pos - Current state of the open position.
 * @returns An object containing the new stop loss and phase if an update is required.
 */
export const processTrailingStop = (pos: PositionState): { newSL: number; phase: number } | null => {
  const { direction, openPrice, currentSL, currentPrice, phase, scaleInLevels, tpLevels, spread, pipSize, pointSize } = pos;
  const isBuy = direction === 'BUY';
  const isXAUUSD = pos.symbol.includes("XAU") || pos.symbol.includes("GOLD");
  const unitSize = isXAUUSD ? pointSize : pipSize;

  let nextPhase = phase;
  let targetSL = currentSL;

  // --- PHASE MANAGEMENT ---
  
  // Phase 2: ScaleIn2 Triggered
  if (phase === 1) {
    const si2 = scaleInLevels[0];
    const triggerMet = isBuy ? currentPrice >= si2.price : currentPrice <= si2.price;
    if (triggerMet) {
      nextPhase = 2;
      targetSL = si2.newStopLoss;
    }
  }

  // Phase 3: ScaleIn3 Triggered
  if (phase === 2) {
    const si3 = scaleInLevels[1];
    const triggerMet = isBuy ? currentPrice >= si3.price : currentPrice <= si3.price;
    if (triggerMet) {
      nextPhase = 3;
      targetSL = si3.newStopLoss;
    }
  }

  // Phase 4 & 5: TP Hits
  if (phase < 4) {
    const tp1Met = isBuy ? currentPrice >= tpLevels[0] : currentPrice <= tpLevels[0];
    if (tp1Met) {
      nextPhase = 4;
      targetSL = tpLevels[0]; // Move stop to TP1
    }
  }
  if (phase < 5) {
    const tp2Met = isBuy ? currentPrice >= tpLevels[1] : currentPrice <= tpLevels[1];
    if (tp2Met) {
      nextPhase = 5;
      targetSL = tpLevels[1]; // Move stop to TP2
    }
  }

  // --- TRAILING LOGIC (Phases 2-5) ---
  if (nextPhase >= 2) {
    const initialSLDistance = new Decimal(Math.abs(openPrice - currentSL)).div(unitSize);
    let trailDistance: Decimal;

    if (nextPhase === 2) {
      trailDistance = initialSLDistance.mul(CONFIG.trailDistanceMultiplier);
    } else {
      const multiplier = isBuy ? CONFIG.trailPhase3Multiplier : (isXAUUSD ? 0.3 : CONFIG.trailPhase3Multiplier);
      trailDistance = initialSLDistance.mul(multiplier);
    }

    const calculatedTrailSL = isBuy 
      ? new Decimal(currentPrice).sub(trailDistance.mul(unitSize)).toNumber()
      : new Decimal(currentPrice).add(trailDistance.mul(unitSize)).toNumber();

    // IDEMPOTENT RULE: Stop only moves in profit direction
    if (isBuy) {
      if (calculatedTrailSL > targetSL) targetSL = calculatedTrailSL;
    } else {
      if (calculatedTrailSL < targetSL || targetSL === 0) targetSL = calculatedTrailSL;
    }
  }

  // FINAL CHECK: Has anything actually changed?
  const slChanged = Math.abs(targetSL - currentSL) > (unitSize * 0.1);
  const phaseChanged = nextPhase !== phase;

  if (slChanged || phaseChanged) {
    // Never allow stop to decrease (Long) or increase (Short)
    if (isBuy && targetSL < currentSL && currentSL !== 0) return null;
    if (!isBuy && targetSL > currentSL && currentSL !== 0) return null;

    return { newSL: targetSL, phase: nextPhase };
  }

  return null;
};
