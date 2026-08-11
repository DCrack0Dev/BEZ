/**
 * confidence-engine/index.ts
 *
 * Combines the rule engine's signal with the neural network's live prediction
 * (when available) into a single, honest confidence score and accept/reject
 * decision. This is the ONLY place in the codebase where AI output is allowed
 * to influence whether a trade is taken — the AI never touches
 * `pendingCommands` directly.
 *
 * Design notes:
 * - The rule engine (`signalValidator.ts`) currently reports a flat, hardcoded
 *   `confidence: 85` (0-100 scale) for every signal that passes its filters.
 *   That number reflects "met all rule conditions", not a calibrated
 *   probability. We normalize it to 0-1 and treat it as a fixed baseline
 *   rather than pretending it's more meaningful than it is.
 * - The AI model (`tradingModel.predict` via `modelManager.predictWithProduction`)
 *   returns real probabilities for BUY/SELL/HOLD plus its own confidence.
 * - `CONFIG.aiTradingEnabled` is the master switch. When false (default), this
 *   engine's `decision` is informational only — the caller (trading-engine)
 *   is responsible for not letting it block anything in that mode. This
 *   module itself does not know or care about that flag; it always computes
 *   an honest evaluation so shadow-mode logs are meaningful, and the caller
 *   decides whether to act on `decision` or just record it.
 */

import { CONFIG } from '../config/tradingConfig';
import { TradingPrediction } from '../ai/tradingModel';

export type SignalDirection = 'BUY' | 'SELL';

export interface RuleSignal {
  direction: SignalDirection;
  /** 0-100 scale, as emitted by signalValidator.ts */
  confidence: number;
}

export interface ConfidenceEvaluation {
  /** Final blended confidence, 0-1 scale. */
  finalConfidence: number;
  /** Rule-engine confidence, normalized to 0-1. */
  ruleConfidence: number;
  /** AI confidence, 0-1 scale, or null if no prediction was available. */
  aiConfidence: number | null;
  /** The AI's most likely action, or null if no prediction was available. */
  aiPredictedAction: 'BUY' | 'SELL' | 'HOLD' | null;
  /** Whether the AI's predicted action agrees with the rule signal's direction. */
  aiAgrees: boolean | null;
  /** ACCEPT = safe to act on (given aiTradingEnabled); REJECT = should be blocked. */
  decision: 'ACCEPT' | 'REJECT';
  /** Human-readable reasons for the decision, for logging/audit. */
  reasons: string[];
}

function normalizeRuleConfidence(rawConfidence: number): number {
  // signalValidator.ts currently emits values on a 0-100 scale (e.g. 85).
  // Defensively handle a 0-1 value too, in case that ever changes upstream.
  if (rawConfidence > 1) return Math.min(1, rawConfidence / 100);
  return Math.max(0, Math.min(1, rawConfidence));
}

export class ConfidenceEngine {
  /**
   * Evaluate a rule-based signal against an (optional) AI prediction.
   *
   * If `aiPrediction` is null (AI unavailable/failed/timed out), this
   * degrades gracefully to rule-only evaluation rather than blocking the
   * signal outright — AI unavailability should never silently disable
   * trading on its own; that's what `CONFIG.aiTradingEnabled` is for.
   */
  public evaluate(
    signal: RuleSignal,
    aiPrediction: TradingPrediction | null
  ): ConfidenceEvaluation {
    const reasons: string[] = [];
    const ruleConfidence = normalizeRuleConfidence(signal.confidence);
    reasons.push(`Rule engine confidence: ${(ruleConfidence * 100).toFixed(1)}%`);

    if (!aiPrediction) {
      reasons.push('No AI prediction available — evaluating on rule confidence only.');
      return {
        finalConfidence: ruleConfidence,
        ruleConfidence,
        aiConfidence: null,
        aiPredictedAction: null,
        aiAgrees: null,
        decision: ruleConfidence >= CONFIG.aiMinConfidence ? 'ACCEPT' : 'REJECT',
        reasons,
      };
    }

    const probs: Record<'BUY' | 'SELL' | 'HOLD', number> = {
      BUY: aiPrediction.buy_probability,
      SELL: aiPrediction.sell_probability,
      HOLD: aiPrediction.hold_probability,
    };
    const aiPredictedAction = (Object.keys(probs) as Array<'BUY' | 'SELL' | 'HOLD'>).reduce(
      (best, key) => (probs[key] > probs[best] ? key : best),
      'HOLD' as 'BUY' | 'SELL' | 'HOLD'
    );
    const aiConfidence = Math.max(0, Math.min(1, Number(aiPrediction.confidence)));
    const aiAgrees = aiPredictedAction === signal.direction;

    reasons.push(
      `AI predicted ${aiPredictedAction} (confidence ${(aiConfidence * 100).toFixed(1)}%; ` +
        `BUY=${(probs.BUY * 100).toFixed(1)}% SELL=${(probs.SELL * 100).toFixed(1)}% HOLD=${(probs.HOLD * 100).toFixed(1)}%)`
    );

    // Hard veto: AI strongly predicts the OPPOSITE direction to the rule signal.
    // (Predicting HOLD is treated as neutral, not a contradiction, since HOLD
    // just means "the model doesn't see a strong setup", not "trade the other way".)
    const opposite: SignalDirection = signal.direction === 'BUY' ? 'SELL' : 'BUY';
    if (aiPredictedAction === opposite && probs[opposite] >= CONFIG.aiContradictionVetoThreshold) {
      reasons.push(
        `AI contradicts rule signal direction with ${(probs[opposite] * 100).toFixed(1)}% ` +
          `probability (>= veto threshold ${(CONFIG.aiContradictionVetoThreshold * 100).toFixed(0)}%) — vetoed.`
      );
      return {
        finalConfidence: 0,
        ruleConfidence,
        aiConfidence,
        aiPredictedAction,
        aiAgrees,
        decision: 'REJECT',
        reasons,
      };
    }

    // Blend: agreement boosts confidence, disagreement (without a hard veto,
    // e.g. AI says HOLD) drags it down. Weighted average favoring neither
    // source exclusively — this is a deliberately simple, auditable formula,
    // not a tuned model; revisit once there's enough shadow-mode data to
    // calibrate weights properly.
    const agreementBonus = aiAgrees ? 0.1 : -0.15;
    const finalConfidence = Math.max(
      0,
      Math.min(1, ruleConfidence * 0.5 + aiConfidence * 0.5 + agreementBonus)
    );
    reasons.push(
      aiAgrees
        ? 'AI agrees with rule signal direction (+confidence).'
        : 'AI does not confirm rule signal direction (-confidence).'
    );

    return {
      finalConfidence,
      ruleConfidence,
      aiConfidence,
      aiPredictedAction,
      aiAgrees,
      decision: finalConfidence >= CONFIG.aiMinConfidence ? 'ACCEPT' : 'REJECT',
      reasons,
    };
  }
}

export const confidenceEngine = new ConfidenceEngine();
