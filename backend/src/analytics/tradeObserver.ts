/**
 * Live Trade Observer — watches every open position on each EA heartbeat.
 *
 * Rates entry quality, timing, and pattern alignment while the trade is running,
 * tracks real MFE/MAE, proposes risk-reducing adjustments, and saves snapshots
 * so Train / Promote on the mobile app uses live experience (not close-only data).
 */

import fs from 'fs';
import path from 'path';
import { appendAudit } from '../monitoring/audit';
import { logger } from '../logging';
import { persistFile } from '../storage/cloudPersistence';

const DATA_DIR = path.join(__dirname, '../../data/learning');
const OBS_PATH = path.join(DATA_DIR, 'live_observations.jsonl');
const LIVE_STATE_PATH = path.join(DATA_DIR, 'live_watch_state.json');

export type TradeGrade = 'A' | 'B' | 'C' | 'D' | 'F';
export type AdjustmentAction =
  | 'HOLD'
  | 'MOVE_SL_BREAKEVEN'
  | 'TIGHTEN_SL'
  | 'TRAIL_CLOSER'
  | 'TAKE_PARTIAL'
  | 'EXIT_EARLY'
  | 'WIDEN_SL_AVOID'; // informational only — never auto-applied

export interface LiveTradeSnapshot {
  ticket: string;
  symbol: string;
  direction: 'BUY' | 'SELL';
  entryPrice: number;
  currentPrice: number;
  sl: number;
  tp: number;
  lotSize: number;
  openTime: number;
  pipSize: number;
  spread: number;
  features: any;
  marketRegime?: string | null;
  detectedPattern?: string | null;
  patternConfidence?: number | null;
  aiConfidence?: number | null;
}

export interface TradeRating {
  overall: TradeGrade;
  score: number; // 0-100
  entry: { score: number; note: string };
  timing: { score: number; note: string };
  pattern: { score: number; note: string };
  risk: { score: number; note: string };
}

export interface TradeAdjustment {
  action: AdjustmentAction;
  reason: string;
  suggestedSl?: number;
  autoApply: boolean; // true only for risk-reducing SL moves
  confidence: number;
}

export interface LiveObservation {
  id: string;
  ticket: string;
  symbol: string;
  direction: 'BUY' | 'SELL';
  timestamp: number;
  ageMinutes: number;
  unrealizedPips: number;
  mfePips: number;
  maePips: number;
  rating: TradeRating;
  adjustment: TradeAdjustment;
  featuresSnapshot?: number[];
  marketRegime?: string | null;
  detectedPattern?: string | null;
  lesson?: string;
}

export interface TicketExcursion {
  mfePips: number;
  maePips: number;
  peakPrice: number;
  troughPrice: number;
  lastObservation?: LiveObservation;
  observationCount: number;
  lastRatedAt: number;
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function gradeFromScore(score: number): TradeGrade {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function featureNums(features: any): number[] {
  const nf = features?.normalizedFeatures;
  if (Array.isArray(nf) && nf.length) {
    const arr = nf.map(Number).slice(0, 50);
    while (arr.length < 50) arr.push(0);
    return arr;
  }
  return new Array(50).fill(0);
}

export class LiveTradeObserver {
  private excursions = new Map<string, TicketExcursion>();
  private recent: LiveObservation[] = [];
  private readonly maxRecent = 100;
  private readonly minRateIntervalMs = 5000; // throttle ratings (still update MFE/MAE every tick)

  observe(snap: LiveTradeSnapshot): {
    observation: LiveObservation | null;
    excursion: TicketExcursion;
    adjustmentCommand?: { action: 'UPDATE_SL'; ticket: string; sl: number; reason: string };
  } {
    const pip = snap.pipSize || 0.01;
    const unrealizedPips =
      snap.direction === 'BUY'
        ? (snap.currentPrice - snap.entryPrice) / pip
        : (snap.entryPrice - snap.currentPrice) / pip;

    let exc = this.excursions.get(snap.ticket);
    if (!exc) {
      exc = {
        mfePips: Math.max(0, unrealizedPips),
        maePips: Math.max(0, -unrealizedPips),
        peakPrice: snap.currentPrice,
        troughPrice: snap.currentPrice,
        observationCount: 0,
        lastRatedAt: 0,
      };
      this.excursions.set(snap.ticket, exc);
    } else {
      if (snap.direction === 'BUY') {
        if (snap.currentPrice > exc.peakPrice) exc.peakPrice = snap.currentPrice;
        if (snap.currentPrice < exc.troughPrice) exc.troughPrice = snap.currentPrice;
        exc.mfePips = Math.max(exc.mfePips, (exc.peakPrice - snap.entryPrice) / pip);
        exc.maePips = Math.max(exc.maePips, (snap.entryPrice - exc.troughPrice) / pip);
      } else {
        if (snap.currentPrice < exc.troughPrice) exc.troughPrice = snap.currentPrice;
        if (snap.currentPrice > exc.peakPrice) exc.peakPrice = snap.currentPrice;
        exc.mfePips = Math.max(exc.mfePips, (snap.entryPrice - exc.troughPrice) / pip);
        exc.maePips = Math.max(exc.maePips, (exc.peakPrice - snap.entryPrice) / pip);
      }
    }

    const now = Date.now();
    if (now - exc.lastRatedAt < this.minRateIntervalMs) {
      return { observation: null, excursion: exc };
    }

    const rating = this.rateTrade(snap, unrealizedPips, exc);
    const adjustment = this.proposeAdjustment(snap, unrealizedPips, exc, rating);
    const ageMinutes = snap.openTime ? (now - snap.openTime) / 60000 : 0;

    const observation: LiveObservation = {
      id: `obs_${snap.ticket}_${now}`,
      ticket: snap.ticket,
      symbol: snap.symbol,
      direction: snap.direction,
      timestamp: now,
      ageMinutes: Math.round(ageMinutes * 10) / 10,
      unrealizedPips: Math.round(unrealizedPips * 10) / 10,
      mfePips: Math.round(exc.mfePips * 10) / 10,
      maePips: Math.round(exc.maePips * 10) / 10,
      rating,
      adjustment,
      featuresSnapshot: featureNums(snap.features),
      marketRegime: snap.marketRegime,
      detectedPattern: snap.detectedPattern,
      lesson: this.buildLesson(rating, adjustment, unrealizedPips),
    };

    exc.lastObservation = observation;
    exc.observationCount += 1;
    exc.lastRatedAt = now;
    this.recent.unshift(observation);
    if (this.recent.length > this.maxRecent) this.recent.pop();

    this.persistObservation(observation);
    this.persistState();

    let adjustmentCommand:
      | { action: 'UPDATE_SL'; ticket: string; sl: number; reason: string }
      | undefined;
    if (
      adjustment.autoApply &&
      adjustment.suggestedSl != null &&
      adjustment.suggestedSl > 0 &&
      adjustment.confidence >= 0.7
    ) {
      adjustmentCommand = {
        action: 'UPDATE_SL',
        ticket: snap.ticket,
        sl: adjustment.suggestedSl,
        reason: adjustment.reason,
      };
    }

    return { observation, excursion: exc, adjustmentCommand };
  }

  /** Call when a ticket closes — returns real MFE/MAE for labeled training. */
  finalize(ticket: string): TicketExcursion | null {
    const exc = this.excursions.get(ticket) || null;
    this.excursions.delete(ticket);
    this.persistState();
    return exc;
  }

  getOpenWatches() {
    return Array.from(this.excursions.entries()).map(([ticket, e]) => ({
      ticket,
      mfePips: e.mfePips,
      maePips: e.maePips,
      observationCount: e.observationCount,
      lastRating: e.lastObservation?.rating?.overall || null,
      lastScore: e.lastObservation?.rating?.score ?? null,
      lastAdjustment: e.lastObservation?.adjustment?.action || null,
      lastLesson: e.lastObservation?.lesson || null,
      unrealizedPips: e.lastObservation?.unrealizedPips ?? null,
    }));
  }

  getRecentObservations(limit = 20) {
    return this.recent.slice(0, limit);
  }

  getStatus() {
    return {
      watching: this.excursions.size,
      openTrades: this.getOpenWatches(),
      recentObservations: this.getRecentObservations(10),
      observationLogPath: OBS_PATH,
    };
  }

  private rateTrade(
    snap: LiveTradeSnapshot,
    unrealizedPips: number,
    exc: TicketExcursion
  ): TradeRating {
    const f = snap.features || {};
    const trend = String(f.trendDirection || 'NEUTRAL');
    const session = String(f.marketSession || '');
    const vol = String(f.volatility || 'MEDIUM');
    const structure = Number(f.bullishStructurePercent || 0);
    const bearStructure = Number(f.bearishStructurePercent || 0);
    const rsi = Number(f.rsiStrength || 50);
    const spreadStatus = String(f.spreadStatus || 'NORMAL');
    const pattern = snap.detectedPattern || f.prevCandlePattern || 'NONE';
    const patternConf = Number(snap.patternConfidence ?? 0.5);

    // --- Entry score ---
    let entryScore = 60;
    let entryNote = 'Neutral entry structure';
    if (snap.direction === 'BUY') {
      if (trend === 'BULLISH') {
        entryScore += 15;
        entryNote = 'BUY aligned with bullish trend';
      } else if (trend === 'BEARISH') {
        entryScore -= 20;
        entryNote = 'BUY against bearish trend';
      }
      if (structure >= 55) entryScore += 10;
      if (rsi > 75) {
        entryScore -= 12;
        entryNote += '; RSI overbought';
      }
    } else {
      if (trend === 'BEARISH') {
        entryScore += 15;
        entryNote = 'SELL aligned with bearish trend';
      } else if (trend === 'BULLISH') {
        entryScore -= 20;
        entryNote = 'SELL against bullish trend';
      }
      if (bearStructure >= 55) entryScore += 10;
      if (rsi < 25) {
        entryScore -= 12;
        entryNote += '; RSI oversold';
      }
    }
    if (spreadStatus === 'WIDE') entryScore -= 8;
    if (spreadStatus === 'EXTREME') entryScore -= 18;

    // --- Timing score ---
    let timingScore = 55;
    let timingNote = 'Session timing average';
    if (session === 'OVERLAP' || session === 'LONDON' || session === 'NEWYORK') {
      timingScore += 20;
      timingNote = `Good session: ${session}`;
    } else if (session === 'ASIA') {
      timingScore -= 15;
      timingNote = 'Asia session — typically weaker edge';
    }
    if (vol === 'EXTREME') {
      timingScore -= 15;
      timingNote += '; extreme volatility';
    } else if (vol === 'HIGH') {
      timingScore -= 5;
    }

    // --- Pattern score ---
    let patternScore = 50;
    let patternNote = 'No strong pattern tagged';
    if (pattern && pattern !== 'NONE') {
      patternScore = 50 + Math.round(patternConf * 40);
      patternNote = `Pattern ${pattern} (conf ${(patternConf * 100).toFixed(0)}%)`;
      // If trade is underwater and pattern fading → penalize
      if (unrealizedPips < -5) {
        patternScore -= 15;
        patternNote += '; thesis under pressure';
      } else if (unrealizedPips > 5) {
        patternScore += 10;
        patternNote += '; thesis confirming';
      }
    }

    // --- Risk score (live excursion) ---
    let riskScore = 60;
    let riskNote = 'Risk profile stable';
    const rrRisk = snap.sl > 0 ? Math.abs(snap.entryPrice - snap.sl) / (snap.pipSize || 0.01) : 0;
    if (exc.maePips > rrRisk * 0.85 && rrRisk > 0) {
      riskScore -= 25;
      riskNote = 'MAE approaching stop — trade under stress';
    } else if (exc.mfePips > rrRisk * 0.5 && unrealizedPips > 0) {
      riskScore += 15;
      riskNote = 'Healthy MFE — room to protect profits';
    }
    if (exc.mfePips > 0 && unrealizedPips < exc.mfePips * 0.3 && exc.mfePips > 8) {
      riskScore -= 10;
      riskNote = 'Gave back most of MFE — consider protecting';
    }

    entryScore = clamp(entryScore, 0, 100);
    timingScore = clamp(timingScore, 0, 100);
    patternScore = clamp(patternScore, 0, 100);
    riskScore = clamp(riskScore, 0, 100);

    const score = Math.round(
      entryScore * 0.3 + timingScore * 0.2 + patternScore * 0.25 + riskScore * 0.25
    );

    return {
      overall: gradeFromScore(score),
      score,
      entry: { score: entryScore, note: entryNote },
      timing: { score: timingScore, note: timingNote },
      pattern: { score: patternScore, note: patternNote },
      risk: { score: riskScore, note: riskNote },
    };
  }

  private proposeAdjustment(
    snap: LiveTradeSnapshot,
    unrealizedPips: number,
    exc: TicketExcursion,
    rating: TradeRating
  ): TradeAdjustment {
    const pip = snap.pipSize || 0.01;
    const slDistancePips =
      snap.sl > 0 ? Math.abs(snap.entryPrice - snap.sl) / pip : 0;

    // Protect profits: move to break-even after solid MFE
    if (exc.mfePips >= Math.max(8, slDistancePips * 0.6) && unrealizedPips >= 3) {
      const be =
        snap.direction === 'BUY'
          ? snap.entryPrice + pip * 2
          : snap.entryPrice - pip * 2;
      const improves =
        snap.direction === 'BUY'
          ? be > snap.sl
          : snap.sl === 0 || be < snap.sl;
      if (improves) {
        return {
          action: 'MOVE_SL_BREAKEVEN',
          reason: `MFE ${exc.mfePips.toFixed(1)} pips — lock break-even +2 pips`,
          suggestedSl: be,
          autoApply: true,
          confidence: 0.85,
        };
      }
    }

    // Trail closer when giving back MFE
    if (exc.mfePips > 12 && unrealizedPips > 0 && unrealizedPips < exc.mfePips * 0.4) {
      const lockPips = Math.max(4, exc.mfePips * 0.35);
      const newSl =
        snap.direction === 'BUY'
          ? snap.entryPrice + lockPips * pip
          : snap.entryPrice - lockPips * pip;
      const improves =
        snap.direction === 'BUY' ? newSl > snap.sl : snap.sl === 0 || newSl < snap.sl;
      if (improves) {
        return {
          action: 'TRAIL_CLOSER',
          reason: `Gave back MFE (${exc.mfePips.toFixed(1)} → ${unrealizedPips.toFixed(1)}) — tighten trail`,
          suggestedSl: newSl,
          autoApply: true,
          confidence: 0.75,
        };
      }
    }

    // Early exit suggestion (manual — do not auto close without user policy)
    if (rating.score < 40 && unrealizedPips < -slDistancePips * 0.5 && slDistancePips > 0) {
      return {
        action: 'EXIT_EARLY',
        reason: `Live grade ${rating.overall} (${rating.score}) with deep MAE — consider cutting`,
        autoApply: false,
        confidence: 0.65,
      };
    }

    if (rating.score >= 75 && unrealizedPips > slDistancePips * 0.8 && snap.tp > 0) {
      return {
        action: 'TAKE_PARTIAL',
        reason: 'Strong grade near TP — consider partial profit',
        autoApply: false,
        confidence: 0.6,
      };
    }

    return {
      action: 'HOLD',
      reason: `Grade ${rating.overall} — continue managing with trail`,
      autoApply: false,
      confidence: 0.5,
    };
  }

  private buildLesson(rating: TradeRating, adj: TradeAdjustment, unrealized: number): string {
    return `Grade ${rating.overall} (${rating.score}). Entry: ${rating.entry.note}. Timing: ${rating.timing.note}. Pattern: ${rating.pattern.note}. Live P/L ${unrealized.toFixed(1)} pips. Action: ${adj.action} — ${adj.reason}`;
  }

  private persistObservation(obs: LiveObservation) {
    try {
      ensureDir();
      fs.appendFileSync(OBS_PATH, JSON.stringify(obs) + '\n');
      // Fire-and-forget cloud dual-write of the log file
      persistFile(OBS_PATH).catch(() => {});
      appendAudit(
        'LEARNING',
        'LIVE_OBSERVATION',
        {
          ticket: obs.ticket,
          grade: obs.rating.overall,
          score: obs.rating.score,
          action: obs.adjustment.action,
          mfe: obs.mfePips,
          mae: obs.maePips,
        },
        undefined,
        'live-observer'
      );
    } catch (e) {
      logger.warn('Failed to persist live observation', String(e));
    }
  }

  private persistState() {
    try {
      ensureDir();
      const payload = {
        updatedAt: Date.now(),
        open: this.getOpenWatches(),
      };
      fs.writeFileSync(LIVE_STATE_PATH, JSON.stringify(payload, null, 2));
      persistFile(LIVE_STATE_PATH).catch(() => {});
    } catch {
      // non-fatal
    }
  }
}

export const liveTradeObserver = new LiveTradeObserver();
