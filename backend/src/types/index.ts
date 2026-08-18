// Shared types for all modules

export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
  x?: number;
}

export interface MT5Payload {
  symbol: string;
  timeframe: string;
  candles: Candle[];
  spread: number;
  balance: number;
  equity: number;
  currency?: string;
  price?: number;
  chart?: Record<string, Candle[]>;
  pipSize: number;
  pointSize: number;
  pipValue: number;
  minLot: number;
  maxLot: number;
  minLotStep: number;
  swingHighs?: number[];
  swingLows?: number[];
  openPositionsCount: number;
  ema20: number;
  ema20Prev: number;
  atr14?: number;
  newsFilterActive?: boolean;
  freeMargin?: number;
  marginLevel?: number;
  margin?: number;
  dailyLossPercent?: number;
  positions?: any[];
  openPositions?: any[];
  closedTrades?: any[];
  autoTradingEnabled?: boolean;
  aiTradingEnabled?: boolean;
  /** When false, skip blocked session filter (trade any time). Default true. */
  timezoneTradingEnabled?: boolean;
  /** Max allowed spread in points (XAUUSD). From app settings / bot config. */
  maxSpreadPoints?: number;
}

export interface PositionState {
  ticket: string;
  signalId: string;
  symbol: string;
  direction: 'BUY' | 'SELL';
  openPrice: number;
  currentSL: number;
  currentPrice: number;
  phase: number;
  scaleInLevels: ScaleInLevel[];
  tpLevels: number[];
  spread: number;
  pipSize: number;
  pointSize: number;
}

export interface TradeSignal {
  id: string;
  symbol: string;
  direction: 'BUY' | 'SELL';
  entryPrice: number;
  stopLoss: number;
  takeProfitLevels: number[];
  scaleInLevels: ScaleInLevel[];
  lotSizes: { entry1: number; entry2: number; entry3: number };
  riskPercent: number;
  pipValue: number;
  timestamp: number;
  timeframe: string;
  confidence: number;
}

export interface RiskParams {
  balance: number;
  equity: number;
  pipValue: number;
  stopLossPips: number;
  riskPercent: number;
  minLot: number;
  maxLot: number;
  lotStep: number;
}

export type TrendDirection = 'BULLISH' | 'BEARISH' | 'NEUTRAL';
export type MarketSession = 'LONDON' | 'NEWYORK' | 'ASIA' | 'OVERLAP';
export type Volatility = 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
export type SpreadStatus = 'NORMAL' | 'WIDE' | 'EXTREME';
export type LiquiditySweep = 'BULLISH' | 'BEARISH' | 'NONE';
export type FVG = 'BULLISH' | 'BEARISH' | 'NONE';
export type OrderBlock = 'BULLISH' | 'BEARISH' | 'NONE';
export type TradeOutcome = 'WIN' | 'LOSS' | 'BREAKEVEN' | 'OPEN';
export type RiskScore = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type StructureType = 'HH_HL' | 'LH_LL' | 'RANGE';
export type NewsImpact = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';

export interface SwingPoint {
  price: number;
  timestamp: number;
  strength: number;
}

export interface FVGDetails {
  type: 'BULLISH' | 'BEARISH' | 'NONE';
  startPrice: number;
  endPrice: number;
  sizePips: number;
  filledPercent: number;
}

export interface OrderBlockDetails {
  type: 'BULLISH' | 'BEARISH' | 'NONE';
  top: number;
  bottom: number;
  displacementStrength: number;
}

export interface ScaleInLevel {
  price: number;
  lotSize?: number;
  newStopLoss: number;
  isRiskFree?: boolean;
}

export interface FeatureSet {
  timestamp: number;
  symbol: string;
  timeframe: string;

  trendStrength: number;
  trendDirection: TrendDirection;
  ema20DistancePips: number;
  ema50DistancePips: number;
  adxValue: number;
  slope20?: number;
  slope50?: number;

  momentumDirection: TrendDirection;
  rsiStrength: number;
  macdMomentum: 'INCREASING' | 'DECREASING' | 'NEUTRAL';
  cciValue?: number;
  williamsR?: number;

  atrRatio: number;
  volatility: Volatility;
  bbPercentWidth?: number;
  bbPosition?: number;
  bbWidth?: number;

  liquiditySweep: LiquiditySweep;

  swingHighs: SwingPoint[];
  swingLows: SwingPoint[];
  nearestSupport?: number;
  nearestResistance?: number;
  structureType?: StructureType;
  structureStrength?: number;

  fvgPresent: FVG;
  fvgDetails?: FVGDetails;
  orderBlockConfirmed: OrderBlock;
  orderBlockDetails?: OrderBlockDetails;

  marketSession: MarketSession;

  prevCandlePattern?: string;
  prevCandleBodyPct?: number;
  prevCandleType?: string;

  volumeRatio?: number;
  newsImpact?: NewsImpact;

  normalizedFeatures: number[];

  spreadStatus: SpreadStatus;
  similarSetupWinRate: number;
  riskScore: RiskScore;
  bullishStructurePercent: number;
  bearishStructurePercent: number;
  candleId?: string;
}

export interface ScreenshotData {
  beforeTrade?: string;
  atEntry?: string;
  afterTrade?: string;
}

export interface TradeDNA {
  id: string;
  ticket: string;
  symbol: string;
  direction: 'BUY' | 'SELL';
  entryTime: number;
  closeTime?: number;
  durationMinutes?: number;
  entryFeatures: FeatureSet;
  closeFeatures?: FeatureSet;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  lotSize: number;
  riskPercent: number;
  slippage: number;
  spreadAtEntry: number;
  executionLatency: number;
  outcome: TradeOutcome;
  profitPips: number;
  profitPercent: number;
  profitDollars: number;
  aiConfidence: number;
  modelVersion: string;
  mistakes?: string[];
  lessons?: string[];
  notes?: string;
  screenshots: ScreenshotData;
  createdAt: number;
  updatedAt: number;
}

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

// ============================================================
// MULTI-MODEL ENSEMBLE (Phase 1) — purely additive, no breaks.
// Existing `TradingPrediction` is treated as the FNN output.
// ============================================================

export type ModelKind = 'FNN' | 'CNN' | 'LSTM' | 'ENSEMBLE';

export interface FNNPrediction {
  kind: 'FNN';
  version: string;
  latencyMs?: number;
  marketQualityScore: number;       // 0-1, how "tradeable" current bar is
  tradeConfidence: number;          // 0-1, confidence in the proposed direction
  bullishProbability: number;       // 0-1
  bearishProbability: number;       // 0-1
  noTradeProbability: number;       // 0-1
  /** Indicator/feature shap-style weights for explainability */
  topDrivers: Array<{ name: string; contribution: number }>;
}

export type ChartPattern =
  | 'TRIANGLE'
  | 'FLAG'
  | 'PENNANT'
  | 'BREAKOUT'
  | 'ORDER_BLOCK'
  | 'LIQUIDITY_SWEEP'
  | 'SUPPORT_HOLD'
  | 'RESISTANCE_HOLD'
  | 'TREND_CONTINUATION'
  | 'REVERSAL'
  | 'NONE';

export interface CNNPrediction {
  kind: 'CNN';
  version: string;
  latencyMs?: number;
  patternConfidence: number;        // 0-1
  pattern: ChartPattern;
  patternProbabilities: Partial<Record<ChartPattern, number>>;
  bullishProbability: number;
  bearishProbability: number;
  noTradeProbability: number;
}

export interface LSTMPrediction {
  kind: 'LSTM';
  version: string;
  latencyMs?: number;
  horizonBars: number;              // e.g. 3 = prediction horizon
  upProbability: number;            // 0-1
  downProbability: number;          // 0-1
  sidewaysProbability: number;      // 0-1
  predictedMoveSizePips: number;    // signed (positive = up)
  confidence: number;               // 0-1
}

export type MarketRegime =
  | 'TRENDING'
  | 'RANGING'
  | 'VOLATILE'
  | 'NEWS_DRIVEN'
  | 'LOW_LIQUIDITY'
  | 'HIGH_LIQUIDITY';

export interface MarketRegimeClassification {
  regime: MarketRegime;
  confidence: number;               // 0-1
  scores: Record<MarketRegime, number>;
  /** Compatible strategies given this regime (rule + model subsets). */
  compatibleStrategies: string[];
  /** Why this regime was chosen */
  reasoning: string;
}

export interface ExplainabilityBundle {
  reason: string;
  confidence: number;
  featuresResponsible: Array<{ name: string; weight: number }>;
  patternDetected: ChartPattern | 'NONE';
  trendDirection: TrendDirection;
  risk: RiskScore;
  expectedRr: number;
  winProbability: number;
  /** Which of the 8 post-trade dimensions *prior* trades in similar setup typically failed on (for user-facing context) */
  typicalFailure?: string;
}

export interface EnsembleDecision {
  timestamp: number;
  symbol: string;
  proposedDirection: 'BUY' | 'SELL';
  finalScore: number;               // 0-1, blended
  decision: 'ACCEPT' | 'REJECT' | 'SHADOW_REJECT';
  fnn: FNNPrediction | null;
  cnn: CNNPrediction | null;
  lstm: LSTMPrediction | null;
  ruleConfidence: number;           // 0-1 (rule engine)
  regime: MarketRegimeClassification;
  agreement: {
    fnn: boolean | null;            // agrees with proposed direction?
    cnn: boolean | null;
    lstm: boolean | null;
    countAgree: number;
    countDisagree: number;
    countUnavailable: number;
  };
  weights: Record<'FNN' | 'CNN' | 'LSTM' | 'RULE', number>;
  perModelFinalScore: Record<'FNN' | 'CNN' | 'LSTM', number | null>;
  explainability: ExplainabilityBundle;
  reasons: string[];
  /** If regime-incompatible, why */
  regimeBlocked?: boolean;
  /** Never remove old fields; this is persisted to SQL + JSONL for training */
  aiMinConfidenceThreshold: number;
}
