import { createGateProposal, listGateProposals } from '../database';
import { gateConfig, GATE_DEFAULTS } from './gateConfig';
import { aiLogger, logger } from '../logging';

type PerformanceSample = {
  totalTrades: number;
  winRate: number;          // 0-1
  avgPnl: number;           // avg dollar per trade
  profitFactor: number;     // grossWins / grossLosses
  avgDrawdownPct: number;   // 0-100
  perDirection?: {
    BUY: { trades: number; winRate: number };
    SELL: { trades: number; winRate: number };
  };
  signalCounts?: {
    totalSignals: number;
    accepted: number;
    rejectedByGate: Record<string, number>; // gateKey → count rejected
  };
};

// CAUTION THRESHOLDS — the model is only allowed to propose changes when
// there's enough evidence, and even then only small, single-step adjustments
// at LOW/MEDIUM risk levels. Never propose REMOVE/DISABLE unless the sample
// is massive AND confidence is near 1 (still always requires user approval).
const PROPOSE_EVERY_N_TRADES = 15;  // analyze performance every 15 closed trades
const MIN_SAMPLE_TO_PROPOSE = 10;   // never propose with <10 trades of evidence
const MIN_CONFIDENCE_TO_PROPOSE = 0.85; // be EXTREMELY cautious before even suggesting
const MAX_ADJUSTMENT_PCT = 0.20;    // never propose more than ±20% change in a single step

type ProposedChange = {
  key: string;
  action: 'ADD' | 'REMOVE' | 'MODIFY' | 'ENABLE' | 'DISABLE';
  from: number;
  to: number;
  rationale: string;
  impact: string;
  risk: 'LOW' | 'MEDIUM' | 'HIGH';
  confidence: number;
};

export class ProposalEngine {
  private lastProposedTradeCount = 0;
  private lastPendingCountByKey: Record<string, number> = {};

  /**
   * Called after trades are finalized. Every PROPOSE_EVERY_N_TRADES, run a
   * single analysis pass → generate at most 2 LOW-risk, 1 MEDIUM-risk
   * proposals (max 3 total per batch), always requiring permission.
   * NEVER applies anything directly.
   */
  async maybeGenerateProposals(performance: PerformanceSample): Promise<Array<any>> {
    const n = performance.totalTrades;
    const justClosedDelta = n - this.lastProposedTradeCount;
    if (justClosedDelta < PROPOSE_EVERY_N_TRADES) return [];
    this.lastProposedTradeCount = n;

    if (n < MIN_SAMPLE_TO_PROPOSE) {
      aiLogger.debug(`ProposalEngine: sample too small (${n} < ${MIN_SAMPLE_TO_PROPOSE}), skipping`);
      return [];
    }

    // Expire/supersede any existing stale PENDING proposals first (safety).
    // Then calculate which new adjustments (if any) make sense.
    const pending = await listGateProposals({ status: 'PENDING_APPROVAL' });
    const pendingByKey = new Set(pending.map((p: any) => String(p.targetGateKey)));

    const changes = this.analyze(performance).filter(c => !pendingByKey.has(c.key));
    // Limit to 3 proposals per batch, sorted by confidence desc, capping risk mix.
    changes.sort((a, b) => b.confidence - a.confidence);
    const finalChanges: ProposedChange[] = [];
    let mediumCount = 0;
    for (const c of changes) {
      if (c.risk === 'HIGH') continue; // never auto-propose HIGH-risk (e.g., gate removal) — user must manually trigger
      if (c.risk === 'MEDIUM') {
        if (mediumCount >= 1) continue;
        mediumCount += 1;
      }
      finalChanges.push(c);
      if (finalChanges.length >= 3) break;
    }

    const created: any[] = [];
    for (const change of finalChanges) {
      const meta = GATE_DEFAULTS[change.key];
      if (!meta) continue;
      const proposal = await createGateProposal({
        targetGateKey: change.key,
        targetGateType: meta.type,
        proposedAction: change.action,
        currentValue: change.from,
        proposedValue: change.to,
        rationale: change.rationale + ` (Sample: ${n} trades; WinRate=${(performance.winRate * 100).toFixed(1)}%; PF=${performance.profitFactor.toFixed(2)})`,
        expectedImpact: change.impact,
        confidence: Math.max(0, Math.min(1, change.confidence)),
        sampleSize: n,
        riskLevel: change.risk,
        symbol: undefined,
        timeframe: undefined,
        modelVersion: undefined,
        expiresInDays: 7,
      });
      if (proposal) {
        created.push(proposal);
        aiLogger.info(`ProposalEngine: created PENDING_APPROVAL proposal #${proposal.id?.slice(0, 7) || ''} for ${change.key} → ${change.action} ${change.from}→${change.to}`);
      }
    }
    return created;
  }

  /**
   * Pure analysis function — no DB writes, no side effects. Can be unit-tested.
   * Returns a list of candidate proposals ranked by confidence. It deliberately
   * only suggests SMALL adjustments and never outright REMOVE/DISABLE.
   */
  analyze(perf: PerformanceSample): ProposedChange[] {
    const out: ProposedChange[] = [];
    if (perf.totalTrades < MIN_SAMPLE_TO_PROPOSE) return out;

    const add = (p: ProposedChange) => {
      if (p.confidence < MIN_CONFIDENCE_TO_PROPOSE) return;
      out.push(p);
    };

    // ---- Helper: compute confidence from sample + lift ----
    const conf = (zScoreEstimate: number, samplePenalty = 0): number => {
      const base = Math.min(0.99, 0.75 + Math.max(0, zScoreEstimate) * 0.05);
      const sampleBonus = Math.min(0.1, Math.max(0, (perf.totalTrades - 10)) * 0.003);
      return Math.max(0, Math.min(1, base + sampleBonus - samplePenalty));
    };

    const clamp20Pct = (from: number, to: number, min?: number, max?: number): number => {
      const delta = to - from;
      const limit = Math.abs(from) * MAX_ADJUSTMENT_PCT + 0.01;
      const safe = Math.abs(delta) > limit ? from + Math.sign(delta) * limit : to;
      if (min !== undefined && safe < min) return min;
      if (max !== undefined && safe > max) return max;
      return safe;
    };

    // ---- 1) If win rate is LOW and PF<1, maybe RAISE soft-thresholds slightly ----
    if (perf.winRate < 0.45 && perf.profitFactor < 1.0) {
      const currentBuySoft = gateConfig.getNum('softThreshold.buy');
      const maxBuy = GATE_DEFAULTS['softThreshold.buy'].max ?? 12;
      const proposed = clamp20Pct(currentBuySoft, currentBuySoft + 1, currentBuySoft, maxBuy);
      if (proposed > currentBuySoft) {
        add({
          key: 'softThreshold.buy',
          action: 'MODIFY',
          from: currentBuySoft,
          to: proposed,
          rationale: `Low win rate (${(perf.winRate * 100).toFixed(1)}%) and PF<1. Raising BUY soft requirement threshold to filter lower-quality signals.`,
          impact: `Expected: ~↑5-8% win rate; ~↓10-20% trade frequency`,
          risk: 'LOW',
          confidence: conf(perf.profitFactor < 0.8 ? 3 : 1.5),
        });
      }
      const currentSellSoft = gateConfig.getNum('softThreshold.sell');
      const maxSell = GATE_DEFAULTS['softThreshold.sell'].max ?? 12;
      const proposedSell = clamp20Pct(currentSellSoft, currentSellSoft + 1, currentSellSoft, maxSell);
      if (proposedSell > currentSellSoft) {
        add({
          key: 'softThreshold.sell',
          action: 'MODIFY',
          from: currentSellSoft,
          to: proposedSell,
          rationale: `Low win rate (${(perf.winRate * 100).toFixed(1)}%) and PF<1. Raising SELL soft requirement threshold.`,
          impact: `Expected: ~↑5-8% win rate on SELLs; ~↓10-20% frequency`,
          risk: 'LOW',
          confidence: conf(perf.profitFactor < 0.8 ? 3 : 1.5, 0.01),
        });
      }
    }

    // ---- 2) If win rate is HIGH, PF>1.2 AND total trades low frequency → LOWER thresholds gently ----
    if (perf.winRate >= 0.60 && perf.profitFactor >= 1.3 && perf.totalTrades <= (perf.signalCounts?.totalSignals ?? perf.totalTrades * 2) * 0.5) {
      const currentBuy = gateConfig.getNum('softThreshold.buy');
      const minBuy = GATE_DEFAULTS['softThreshold.buy'].min ?? 1;
      const propBuy = clamp20Pct(currentBuy, currentBuy - 1, minBuy, currentBuy);
      if (propBuy < currentBuy) {
        add({
          key: 'softThreshold.buy',
          action: 'MODIFY',
          from: currentBuy,
          to: propBuy,
          rationale: `High win rate (${(perf.winRate * 100).toFixed(1)}%) + healthy PF (${perf.profitFactor.toFixed(2)}) — can afford looser BUY filter safely.`,
          impact: `Expected: ~↑10-25% trade frequency while maintaining profitability.`,
          risk: 'MEDIUM',
          confidence: conf(2.5),
        });
      }
    }

    // ---- 3) Direction imbalance: SELLs losing badly but BUYs ok → bump SELL threshold ----
    if (perf.perDirection) {
      const { BUY, SELL } = perf.perDirection;
      if (BUY.trades >= 8 && SELL.trades >= 8) {
        if (BUY.winRate - SELL.winRate >= 0.20) {
          const current = gateConfig.getNum('softThreshold.sell');
          const maxS = GATE_DEFAULTS['softThreshold.sell'].max ?? 12;
          const proposed = clamp20Pct(current, current + 1, current, maxS);
          if (proposed > current) {
            add({
              key: 'softThreshold.sell',
              action: 'MODIFY',
              from: current,
              to: proposed,
              rationale: `Direction imbalance: BUY WR=${(BUY.winRate * 100).toFixed(1)}% vs SELL WR=${(SELL.winRate * 100).toFixed(1)}%. SELLs are materially worse.`,
              impact: `Expected: ~↓SELL frequency; ↑ SELL subset win rate by ~5-10%.`,
              risk: 'LOW',
              confidence: conf(2.2),
            });
          }
        }
        if (SELL.winRate - BUY.winRate >= 0.20) {
          const current = gateConfig.getNum('softThreshold.buy');
          const maxB = GATE_DEFAULTS['softThreshold.buy'].max ?? 12;
          const proposed = clamp20Pct(current, current + 1, current, maxB);
          if (proposed > current) {
            add({
              key: 'softThreshold.buy',
              action: 'MODIFY',
              from: current,
              to: proposed,
              rationale: `Direction imbalance: SELL WR=${(SELL.winRate * 100).toFixed(1)}% > BUY WR=${(BUY.winRate * 100).toFixed(1)}% by ≥20%.`,
              impact: `Expected: ~↓BUY frequency; ↑ BUY subset win rate by ~5-10%.`,
              risk: 'LOW',
              confidence: conf(2.2, 0.005),
            });
          }
        }
      }
    }

    // ---- 4) Most common rejection gate → consider gently loosening ONLY if PF>1.2 ----
    if (perf.profitFactor >= 1.2 && perf.winRate >= 0.55 && perf.signalCounts) {
      const rejected = perf.signalCounts.rejectedByGate || {};
      const entries = Object.entries(rejected).sort((a, b) => b[1] - a[1]);
      if (entries.length > 0) {
        const [worstGate, worstCount] = entries[0];
        const totalRejected = Object.values(rejected).reduce((a, b) => a + b, 0);
        if (totalRejected > 0 && worstCount / totalRejected >= 0.45) {
          // >45% of all rejections come from ONE gate → this gate is the bottleneck.
          // Propose either a GENTLE nudge in threshold OR enable/disable only at LOW risk.
          if (worstGate === 'adxTrend') {
            const cur = gateConfig.getNum('filter.adxTrend.min');
            const meta = GATE_DEFAULTS['filter.adxTrend.min'];
            const newVal = clamp20Pct(cur, cur - 2, meta?.min ?? 0, meta?.max ?? cur);
            if (newVal < cur) {
              add({
                key: 'filter.adxTrend.min',
                action: 'MODIFY',
                from: cur,
                to: newVal,
                rationale: `Top rejection gate: ${worstGate} (${Math.round(worstCount / totalRejected * 100)}% of rejections). PF is healthy, so a small ADX relax is low-risk.`,
                impact: `Expected: trades ↑ 5-15%; WR likely unchanged because overall strategy is already profitable.`,
                risk: 'MEDIUM',
                confidence: conf(1.6),
              });
            }
          } else if (worstGate === 'rsiFilter') {
            const curMin = gateConfig.getNum('filter.rsi.min');
            const curMax = gateConfig.getNum('filter.rsi.max');
            // Widen the RSI window by a small step: lower min, raise max
            const metaMin = GATE_DEFAULTS['filter.rsi.min'];
            const metaMax = GATE_DEFAULTS['filter.rsi.max'];
            const newMin = clamp20Pct(curMin, curMin - 0.03, metaMin?.min ?? 0, curMin);
            const newMax = clamp20Pct(curMax, curMax + 0.03, curMax, metaMax?.max ?? 1);
            if (newMin < curMin) {
              add({
                key: 'filter.rsi.min',
                action: 'MODIFY',
                from: curMin,
                to: newMin,
                rationale: `rsiFilter is top rejection gate (${worstCount} rejects). Healthy PF; gently widen RSI lower bound.`,
                impact: `Expected: trade frequency ↑ 5-10%. WR impact ~neutral.`,
                risk: 'LOW',
                confidence: conf(1.4, 0.01),
              });
            }
            if (newMax > curMax) {
              add({
                key: 'filter.rsi.max',
                action: 'MODIFY',
                from: curMax,
                to: newMax,
                rationale: `rsiFilter is top rejection gate (${worstCount} rejects). Healthy PF; gently widen RSI upper bound.`,
                impact: `Expected: trade frequency ↑ 5-10%. WR impact ~neutral.`,
                risk: 'LOW',
                confidence: conf(1.4, 0.012),
              });
            }
          }
        }
      }
    }

    return out;
  }
}

export const proposalEngine = new ProposalEngine();
