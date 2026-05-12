import { emitStopUpdate, emitScaleInTrigger } from './signalEmitter';

/**
 * shortTrailingStopManager.ts
 * Manages trailing stop for SELL positions (stops move DOWN).
 */

interface ShortActivePosition {
  ticket: string;
  signalId: string;
  symbol: "XAUUSD";
  type: 'SELL';
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

export const manageShortTrailingStop = (position: ShortActivePosition): { action: string; payload: any } | null => {
  const { ticket, openPrice, currentSL, currentPrice, phase, scaleIn2Price, scaleIn3Price, tp1, tp2, tp3 } = position;
  const spread = 0.0035; // XAUUSD buffer

  // PHASE 1 -> 2: Scale-In 2 Trigger (Price dropped to SI2)
  if (phase === 1 && currentPrice <= scaleIn2Price) {
    emitScaleInTrigger(position.signalId, 2, scaleIn2Price, 0, openPrice - spread);
    emitStopUpdate(ticket, openPrice - spread, 2, true);
    return { action: 'MODIFY_SL', payload: { ticket, sl: openPrice - spread, tp: tp1 } };
  }

  // PHASE 2 -> 3: Scale-In 3 Trigger
  if (phase === 2 && currentPrice <= scaleIn3Price) {
    emitScaleInTrigger(position.signalId, 3, scaleIn3Price, 0, scaleIn2Price - spread);
    emitStopUpdate(ticket, scaleIn2Price - spread, 3, true);
    return { action: 'MODIFY_SL', payload: { ticket, sl: scaleIn2Price - spread, tp: tp2 } };
  }

  // PHASE 4: TP1 Hit
  if (currentPrice <= tp1 && phase < 4) {
    emitStopUpdate(ticket, tp1, 4, true);
    return { action: 'MODIFY_SL', payload: { ticket, sl: tp1, tp: tp3 } };
  }

  // PHASE 5: TP2 Hit
  if (currentPrice <= tp2 && phase < 5) {
    emitStopUpdate(ticket, tp2, 5, true);
    return { action: 'MODIFY_SL', payload: { ticket, sl: tp2, tp: tp3 } };
  }

  // Trail Stop Down (Stop only moves DOWN for shorts)
  const trailDistance = Math.abs(openPrice - currentSL) * 0.75;
  const newTrailSL = currentPrice + trailDistance;
  
  if (newTrailSL < currentSL && phase >= 2) {
    emitStopUpdate(ticket, newTrailSL, phase, true);
    return { action: 'MODIFY_SL', payload: { ticket, sl: newTrailSL, tp: tp3 } };
  }

  return null;
};
