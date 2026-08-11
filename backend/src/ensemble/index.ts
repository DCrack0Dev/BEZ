/**
 * Ensemble Decision Engine — Phase 1
 *
 * Combines:
 *   - FNN   (indicator-based):  current market quality + direction confidence
 *   - CNN   (pattern-based):     chart pattern probability (OHLC "image")
 *   - LSTM  (sequence-based):   short-horizon directional forecast
 *   - RULE  (signal validator): blended as an equal-rights voter
 *
 * Design rules:
 *  - NEVER blocks trades on its own unless `hardGate=true` AND every
 *    available model + rule explicitly disagrees with the signal direction.
 *    Default is shadow mode: SHADOW_REJECT lets caller log-and-ignore so
 *    we gather performance data before gating real capital.
 *  - Degrades gracefully: missing CNN / LSTM (weights not yet trained,
 *    python process down, etc.) → the other voters still count, weights
 *    renormalize so the final score remains on the same 0-1 scale.
 *  - Returns full explainability: reasoning list, per-model scores,
 *    agreement counts, top feature drivers, regime note.
 */

import {
  FNNPrediction,
  CNNPrediction,
  LSTMPrediction,
  EnsembleDecision,
  MarketRegimeClassification,
  TrendDirection,
  RiskScore,
  ChartPattern,
} from '../types';
import { CONFIG } from '../config/tradingConfig';
import { TradingPrediction } from '../ai/tradingModel';

export type SignalDirection = 'BUY' | 'SELL';

export interface EnsembleInputs {
  symbol: string;
  proposedDirection: SignalDirection;
  ruleConfidence: number;             // 0-1
  regime: MarketRegimeClassification;
  trendDirection: TrendDirection;
  riskScore: RiskScore;
  expectedRr: number;
  /** Optional: full TradingPrediction from existing Python inference bridge.
   *  When CNN/LSTM aren't wired yet, this is our ONLY neural signal, and
   *  we treat it as the FNN (it already outputs direction probs + conf). */
  legacyTradingPrediction: TradingPrediction | null;
  fnn?: FNNPrediction | null;
  cnn?: CNNPrediction | null;
  lstm?: LSTMPrediction | null;
  /** 50-dim feature names aligned with featureVector output */
  featureNames?: string[];
  /** If caller already has shap/driver-style weights we can reuse them */
  featureWeights?: Array<{ name: string; weight: number }>;
  /** If true, hard REJECT decisions are allowed (default false = shadow mode). */
  hardGate?: boolean;
  /** Signal validator / confluence reason string (added to reasons[]). */
  ruleReason?: string;
  /** Minimum number of models (out of FNN/CNN/LSTM) that must agree for ACCEPT. */
  minAgreeingModels?: number;
}

export interface EnsembleWeights {
  FNN: number;
  CNN: number;
  LSTM: number;
  RULE: number;
}

const DEFAULT_WEIGHTS: EnsembleWeights = {
  FNN: 0.35,
  CNN: 0.25,
  LSTM: 0.25,
  RULE: 0.15,
};

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
}

function legacyToFNN(p: TradingPrediction, version = 'production'): FNNPrediction {
  const topDrivers: FNNPrediction['topDrivers'] = [
    { name: 'direction_consensus', contribution: p.confidence },
    { name: 'expected_reward', contribution: clamp01(p.expected_reward / 100) },
    { name: 'expected_risk_penalty', contribution: 1 - clamp01(p.expected_risk / 100) },
  ];
  return {
    kind: 'FNN',
    version,
    marketQualityScore: clamp01(p.confidence),
    tradeConfidence: clamp01(p.confidence),
    bullishProbability: clamp01(p.buy_probability),
    bearishProbability: clamp01(p.sell_probability),
    noTradeProbability: clamp01(p.hold_probability),
    topDrivers,
  };
}

function buildFnnScore(fnn: FNNPrediction, direction: SignalDirection): number {
  const dirProb = direction === 'BUY' ? fnn.bullishProbability : fnn.bearishProbability;
  const marketQ = fnn.marketQualityScore;
  const tradeC = fnn.tradeConfidence;
  return clamp01(0.5 * dirProb + 0.25 * marketQ + 0.25 * tradeC);
}

function buildCnnScore(cnn: CNNPrediction, direction: SignalDirection): number {
  const dirProb = direction === 'BUY' ? cnn.bullishProbability : cnn.bearishProbability;
  const patternBoost = cnn.patternConfidence;
  return clamp01(0.6 * dirProb + 0.4 * patternBoost);
}

function buildLstmScore(lstm: LSTMPrediction, direction: SignalDirection): number {
  const dirProb = direction === 'BUY' ? lstm.upProbability : lstm.downProbability;
  return clamp01(0.7 * dirProb + 0.3 * lstm.confidence);
}

function doesAgree(
  pred: FNNPrediction | CNNPrediction | LSTMPrediction | null,
  direction: SignalDirection
): boolean | null {
  if (!pred) return null;
  if (pred.kind === 'FNN') {
    if (pred.noTradeProbability > 0.5) return false;
    return direction === 'BUY'
      ? pred.bullishProbability > pred.bearishProbability
      : pred.bearishProbability > pred.bullishProbability;
  }
  if (pred.kind === 'CNN') {
    if (pred.noTradeProbability > 0.5) return false;
    return direction === 'BUY'
      ? pred.bullishProbability > pred.bearishProbability
      : pred.bearishProbability > pred.bullishProbability;
  }
  // LSTM
  return direction === 'BUY'
    ? pred.upProbability > pred.downProbability
    : pred.downProbability > pred.upProbability;
}

function pickPattern(cnn: CNNPrediction | null): ChartPattern | 'NONE' {
  return cnn?.pattern && cnn.patternConfidence > 0.3 ? cnn.pattern : 'NONE';
}

function riskScoreToNumber(r: RiskScore): number {
  switch (r) {
    case 'LOW': return 0.25;
    case 'MEDIUM': return 0.5;
    case 'HIGH': return 0.75;
    case 'CRITICAL': return 1;
  }
}

export class EnsembleDecisionEngine {
  private readonly weights: EnsembleWeights;

  constructor(customWeights?: Partial<EnsembleWeights>) {
    this.weights = { ...DEFAULT_WEIGHTS, ...(customWeights || {}) };
  }

  public evaluate(inputs: EnsembleInputs): EnsembleDecision {
    const {
      symbol,
      proposedDirection: dir,
      ruleConfidence: rawRule,
      regime,
      trendDirection,
      riskScore,
      expectedRr,
      legacyTradingPrediction,
      featureWeights,
      featureNames,
      hardGate = false,
      ruleReason,
      minAgreeingModels = 0,
    } = inputs;

    const reasons: string[] = [];
    const ruleConfidence = clamp01(rawRule);
    if (ruleReason) reasons.push(`Rule: ${ruleReason} (conf=${(ruleConfidence * 100).toFixed(1)}%)`);

    // Resolve FNN: new-style if given, else bridge legacy TradingPrediction
    // (the current python model). This preserves 100% of existing behavior.
    let fnn: FNNPrediction | null = inputs.fnn ?? null;
    if (!fnn && legacyTradingPrediction) {
      fnn = legacyToFNN(legacyTradingPrediction, 'production-fnn-bridge');
      reasons.push(
        `FNN (bridge): BUY=${(fnn.bullishProbability * 100).toFixed(1)}% ` +
          `SELL=${(fnn.bearishProbability * 100).toFixed(1)}% ` +
          `HOLD=${(fnn.noTradeProbability * 100).toFixed(1)}%`
      );
    } else if (fnn) {
      reasons.push(
        `FNN v${fnn.version}: BUY=${(fnn.bullishProbability * 100).toFixed(1)}% ` +
          `SELL=${(fnn.bearishProbability * 100).toFixed(1)}% marketQ=${(fnn.marketQualityScore * 100).toFixed(1)}%`
      );
    } else {
      reasons.push('FNN: unavailable');
    }

    const cnn: CNNPrediction | null = inputs.cnn ?? null;
    if (cnn) {
      reasons.push(
        `CNN v${cnn.version}: pattern=${cnn.pattern} @ ${(cnn.patternConfidence * 100).toFixed(1)}% ` +
          `BUY=${(cnn.bullishProbability * 100).toFixed(1)}% SELL=${(cnn.bearishProbability * 100).toFixed(1)}%`
      );
    } else {
      reasons.push('CNN: unavailable (shadow weights not loaded yet)');
    }

    const lstm: LSTMPrediction | null = inputs.lstm ?? null;
    if (lstm) {
      reasons.push(
        `LSTM v${lstm.version}: UP=${(lstm.upProbability * 100).toFixed(1)}% ` +
          `DOWN=${(lstm.downProbability * 100).toFixed(1)}% SIDE=${(lstm.sidewaysProbability * 100).toFixed(1)}% ` +
          `horizon=${lstm.horizonBars}bars move=${lstm.predictedMoveSizePips.toFixed(1)}pips`
      );
    } else {
      reasons.push('LSTM: unavailable (shadow weights not loaded yet)');
    }

    // Build per-model 0-1 scores
    const fnnScore: number | null = fnn ? buildFnnScore(fnn, dir) : null;
    const cnnScore: number | null = cnn ? buildCnnScore(cnn, dir) : null;
    const lstmScore: number | null = lstm ? buildLstmScore(lstm, dir) : null;
    const ruleScore = ruleConfidence;

    // Renormalize weights for available signals only
    let activeW = { FNN: fnnScore != null ? this.weights.FNN : 0, CNN: cnnScore != null ? this.weights.CNN : 0, LSTM: lstmScore != null ? this.weights.LSTM : 0, RULE: this.weights.RULE };
    const totalW = activeW.FNN + activeW.CNN + activeW.LSTM + activeW.RULE;
    const normalizedWeights = {
      FNN: totalW > 0 ? activeW.FNN / totalW : 0,
      CNN: totalW > 0 ? activeW.CNN / totalW : 0,
      LSTM: totalW > 0 ? activeW.LSTM / totalW : 0,
      RULE: totalW > 0 ? activeW.RULE / totalW : 0,
    };

    const finalScore = clamp01(
      (fnnScore ?? 0) * normalizedWeights.FNN +
      (cnnScore ?? 0) * normalizedWeights.CNN +
      (lstmScore ?? 0) * normalizedWeights.LSTM +
      ruleScore * normalizedWeights.RULE
    );

    // Agreement counting
    const agreeFnn = doesAgree(fnn, dir);
    const agreeCnn = doesAgree(cnn, dir);
    const agreeLstm = doesAgree(lstm, dir);
    const agreeRule = ruleConfidence >= CONFIG.aiMinConfidence;
    const availableModels = [agreeFnn, agreeCnn, agreeLstm].filter((a) => a !== null).length;
    const countAgree = [agreeFnn, agreeCnn, agreeLstm].filter((a) => a === true).length + (agreeRule ? 1 : 0);
    const countDisagree = [agreeFnn, agreeCnn, agreeLstm].filter((a) => a === false).length + (!agreeRule ? 0 : 0);
    const countUnavailable = [agreeFnn, agreeCnn, agreeLstm].filter((a) => a === null).length;

    // Determine decision
    const minConf = CONFIG.aiMinConfidence;
    const regimeIncompatible = !regime.compatibleStrategies.includes('ALL') && !regime.compatibleStrategies.includes(dir === 'BUY' ? 'BUY_RULES' : 'SELL_RULES');

    // Count how many of the available neural models agree
    const neuralAgree = [agreeFnn, agreeCnn, agreeLstm].filter((a) => a === true).length;
    const needAgree = Math.min(Math.max(1, minAgreeingModels), Math.max(1, availableModels));

    let decision: EnsembleDecision['decision'] = 'ACCEPT';
    if (regimeIncompatible) {
      decision = hardGate ? 'REJECT' : 'SHADOW_REJECT';
      reasons.push(`REGIME INCOMPATIBLE: ${regime.regime} — strategies allowed: ${regime.compatibleStrategies.join(', ')}`);
    } else if (neuralAgree < needAgree && availableModels >= 2) {
      decision = hardGate ? 'REJECT' : 'SHADOW_REJECT';
      reasons.push(`Ensemble disagreement: ${neuralAgree}/${availableModels} neural models agree. Need ≥${needAgree}.`);
    } else if (finalScore < minConf) {
      decision = hardGate ? 'REJECT' : 'SHADOW_REJECT';
      reasons.push(`Ensemble finalScore ${(finalScore * 100).toFixed(1)}% below threshold ${(minConf * 100).toFixed(0)}%.`);
    } else {
      reasons.push(`Ensemble score ${(finalScore * 100).toFixed(1)}% → PASS (threshold ${(minConf * 100).toFixed(0)}%).`);
    }

    // Explainability bundle
    const patternDetected = pickPattern(cnn);
    const winProb = clamp01(
      (fnnScore ?? ruleScore) * 0.35 +
      (cnnScore ?? ruleScore) * 0.25 +
      (lstmScore ?? ruleScore) * 0.25 +
      ruleScore * 0.15
    );

    const featuresResponsible = featureWeights && featureWeights.length > 0
      ? [...featureWeights].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)).slice(0, 5)
      : [
          { name: 'trend_alignment', weight: (trendDirection === 'NEUTRAL' ? 0.5 : (dir === 'BUY' ? (trendDirection === 'BULLISH' ? 1 : 0) : (trendDirection === 'BEARISH' ? 1 : 0))) },
          { name: 'rule_confidence', weight: ruleConfidence },
          { name: 'market_quality', weight: fnn?.marketQualityScore ?? ruleScore },
          { name: 'risk_score_penalty', weight: 1 - riskScoreToNumber(riskScore) },
          { name: 'rr_expectancy', weight: clamp01(expectedRr / 5) },
        ].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));

    const topReasonParts: string[] = [];
    topReasonParts.push(`${decision} ${dir}`);
    if (regime.confidence > 0.6) topReasonParts.push(`regime=${regime.regime}`);
    if (patternDetected && patternDetected !== 'NONE') topReasonParts.push(`pattern=${patternDetected}`);
    topReasonParts.push(`score=${(finalScore * 100).toFixed(0)}%`);
    topReasonParts.push(`agreement=${countAgree}/${availableModels + 1}`);

    const explainability = {
      reason: topReasonParts.join(' · '),
      confidence: finalScore,
      featuresResponsible,
      patternDetected,
      trendDirection,
      risk: riskScore,
      expectedRr,
      winProbability: winProb,
    };

    return {
      timestamp: Date.now(),
      symbol,
      proposedDirection: dir,
      finalScore,
      decision,
      fnn,
      cnn,
      lstm,
      ruleConfidence,
      regime,
      agreement: {
        fnn: agreeFnn,
        cnn: agreeCnn,
        lstm: agreeLstm,
        countAgree,
        countDisagree,
        countUnavailable,
      },
      weights: normalizedWeights,
      perModelFinalScore: { FNN: fnnScore, CNN: cnnScore, LSTM: lstmScore },
      explainability,
      reasons,
      regimeBlocked: regimeIncompatible || undefined,
      aiMinConfidenceThreshold: minConf,
    };
  }
}

export const ensembleDecisionEngine = new EnsembleDecisionEngine();
