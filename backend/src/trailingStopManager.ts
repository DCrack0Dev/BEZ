import { CONFIG } from './tradingConfig';
import { emitStopUpdate, emitScaleInTrigger } from './signalEmitter';

/**
 * trailingStopManager.ts
 * Manages trailing stop phases and scale-in triggers.
 */

interface ActivePosition {
  ticket: string;
  signalId: string;
  symbol: string;
  type: 'BUY';
  openPrice: number;
  currentSL: number;
  currentPrice: number;
  phase: number;
  scaleIn2Price: number;
  scaleIn3Price: number;
  tp1: number;
  tp2: number;
  tp3: number;
}

/**
 * Processes active positions and calculates stop updates or scale-in triggers.
 */
export const manageTrailingStop = (position: any): { action: string; payload: any } | null => {
  const { ticket, type, openPrice, currentSL, currentPrice, profitPips } = position;
  const isBuy = type === 'BUY';
  const pipSize = 0.0001; // Should be dynamic based on symbol
  
  // --- AGGRESSIVE SCALPING EXIT ---
  // 1. Partial Close: 50% at 5 pips
  if (profitPips >= 5 && !position.partiallyClosed) {
    return { action: 'PARTIAL_CLOSE', payload: { ticket, percent: 0.50, reason: 'Scalp TP1' } };
  }

  // 2. Aggressive Trailing: 3 pips
  const trailDistance = 3 * pipSize;
  let newSL = isBuy ? currentPrice - trailDistance : currentPrice + trailDistance;

  // Ensure stop only moves in profit direction
  const isImprovement = isBuy ? (newSL > currentSL) : (newSL < currentSL || currentSL === 0);
  
  if (isImprovement && profitPips >= 3) {
    emitStopUpdate(ticket, newSL, 2, true);
    return { action: 'MODIFY_SL', payload: { ticket, sl: newSL } };
  }

  // 3. Cut losses fast: Exit if 3 pips against
  const lossPips = isBuy ? (openPrice - currentPrice) / pipSize : (currentPrice - openPrice) / pipSize;
  if (lossPips >= 3) {
    return { action: 'CLOSE_TRADE', payload: { ticket, reason: 'Scalp SL Cut' } };
  }

  return null;
};
