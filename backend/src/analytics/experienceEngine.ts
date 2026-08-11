import { TradeDNA } from './tradeDna';
import { FeatureSet } from '../types';

/**
 * Experience Engine
 * Analyzes closed trades, generates lessons, and builds training dataset
 */

export interface Lesson {
  id: string;
  category: 'RISK' | 'ENTRY' | 'EXIT' | 'MOMENTUM' | 'STRUCTURE';
  title: string;
  description: string;
  impact: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  relatedDnaIds: string[];
  timestamp: number;
}

export interface ModelCandidate {
  id: string;
  version: string;
  trainingDate: number;
  winRate: number;
  profitFactor: number;
  avgProfit: number;
  sharpeRatio: number;
  status: 'TRAINING' | 'EVALUATING' | 'RECOMMENDED' | 'DEPLOYED' | 'ARCHIVED';
  deploymentRecommendation: 'YES' | 'NO' | 'MONITOR';
  recommendationReason: string;
}

export class ExperienceEngine {
  private lessons: Lesson[] = [];
  private modelCandidates: ModelCandidate[] = [];
  private readonly maxLessons = 1000;

  /**
   * Analyze a closed Trade DNA and generate lessons
   */
  public analyzeTrade(dna: TradeDNA): Lesson[] {
    const generatedLessons: Lesson[] = [];

    // Lesson 1: Risk Management
    if (dna.riskPercent > 2.0) {
      generatedLessons.push({
        id: `lesson_${Date.now()}_1`,
        category: 'RISK',
        title: 'Risk Too High',
        description: `Trade risk was ${dna.riskPercent.toFixed(1)}%, which exceeds recommended 1.0-1.5%`,
        impact: 'HIGH',
        relatedDnaIds: [dna.id],
        timestamp: Date.now()
      });
    }

    // Lesson 2: Volatility
    if (dna.entryFeatures.volatility === 'EXTREME' && dna.outcome === 'LOSS') {
      generatedLessons.push({
        id: `lesson_${Date.now()}_2`,
        category: 'RISK',
        title: 'Avoided Extreme Volatility?',
        description: `Loss during EXTREME volatility. Consider widening stops or skipping trades.`,
        impact: 'MEDIUM',
        relatedDnaIds: [dna.id],
        timestamp: Date.now()
      });
    }

    // Lesson 3: Session Timing
    if (dna.entryFeatures.marketSession === 'ASIA' && dna.outcome === 'LOSS') {
      generatedLessons.push({
        id: `lesson_${Date.now()}_3`,
        category: 'ENTRY',
        title: 'Session Performance',
        description: `Loss during ASIA session. Consider focusing on LONDON/NEWYORK/OVERLAP.`,
        impact: 'MEDIUM',
        relatedDnaIds: [dna.id],
        timestamp: Date.now()
      });
    }

    // Lesson 4: Trend Alignment
    if (
      (dna.direction === 'BUY' && dna.entryFeatures.trendDirection === 'BEARISH') ||
      (dna.direction === 'SELL' && dna.entryFeatures.trendDirection === 'BULLISH')
    ) {
      generatedLessons.push({
        id: `lesson_${Date.now()}_4`,
        category: 'STRUCTURE',
        title: 'Against Trend',
        description: `Trade was against primary trend. Consider only trend-aligned trades.`,
        impact: 'CRITICAL',
        relatedDnaIds: [dna.id],
        timestamp: Date.now()
      });
    }

    this.lessons = [...this.lessons, ...generatedLessons].slice(-this.maxLessons);
    return generatedLessons;
  }

  /**
   * Build training dataset from all finalized Trade DNA entries
   */
  public buildTrainingDataset(dnaEntries: TradeDNA[]): Array<{
    features: Partial<FeatureSet>;
    target: {
      win: boolean;
      profitPips: number;
      profitPercent: number;
    };
  }> {
    const finalized = dnaEntries.filter(d => d.outcome !== 'OPEN');
    const dataset = [];

    for (const dna of finalized) {
      dataset.push({
        features: {
          ...dna.entryFeatures,
          riskPercent: dna.riskPercent
        },
        target: {
          win: dna.outcome === 'WIN',
          profitPips: dna.profitPips,
          profitPercent: dna.profitPercent
        }
      });
    }

    console.log(`📊 Training dataset built: ${dataset.length} samples`);
    return dataset;
  }

  /**
   * Evaluate a candidate model (placeholder for real evaluation)
   */
  public evaluateModelCandidate(dnaEntries: TradeDNA[], modelVersion: string): ModelCandidate {
    const finalized = dnaEntries.filter(d => d.outcome !== 'OPEN');
    const wins = finalized.filter(d => d.outcome === 'WIN').length;
    const total = finalized.length || 1;
    const winRate = wins / total;
    const profitFactor = 1.2 + (winRate * 0.5); // Placeholder
    const avgProfit = winRate > 0.5 ? 20 : -10; // Placeholder
    const sharpeRatio = winRate > 0.6 ? 1.2 : 0.8; // Placeholder

    let deploymentRecommendation: ModelCandidate['deploymentRecommendation'] = 'NO';
    let recommendationReason = '';
    if (winRate >= 0.65 && profitFactor > 1.4) {
      deploymentRecommendation = 'YES';
      recommendationReason = `Strong performance: ${(winRate * 100).toFixed(1)}% WR, ${profitFactor.toFixed(2)} PF`;
    } else if (winRate >= 0.55 && profitFactor > 1.2) {
      deploymentRecommendation = 'MONITOR';
      recommendationReason = `Good potential, track performance in live demo first`;
    } else {
      deploymentRecommendation = 'NO';
      recommendationReason = `Needs improvement: ${(winRate * 100).toFixed(1)}% WR, ${profitFactor.toFixed(2)} PF`;
    }

    const candidate: ModelCandidate = {
      id: `model_${Date.now()}`,
      version: modelVersion,
      trainingDate: Date.now(),
      winRate,
      profitFactor,
      avgProfit,
      sharpeRatio,
      status: 'EVALUATING',
      deploymentRecommendation,
      recommendationReason
    };

    this.modelCandidates.push(candidate);
    console.log(`🤖 Model candidate evaluated: ${modelVersion} → ${deploymentRecommendation}`);
    return candidate;
  }

  /**
   * Get all lessons
   */
  public getLessons(): Lesson[] {
    return [...this.lessons].sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Get model candidates
   */
  public getModelCandidates(): ModelCandidate[] {
    return [...this.modelCandidates].sort((a, b) => b.trainingDate - a.trainingDate);
  }
}
