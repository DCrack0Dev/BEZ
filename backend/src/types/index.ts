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
  positions?: any[];
  openPositions?: any[];
  closedTrades?: any[];
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
  scaleInLevels: number[];
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
  lotSizes: { entry1: number; entry2?: number; entry3?: number };
  confidence: number;
  timestamp: number;
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

export interface FeatureSet {
  timestamp: number;
  symbol: string;
  trendStrength: number;
  trendDirection: TrendDirection;
  ema20DistancePips: number;
  ema50DistancePips: number;
  atrRatio: number;
  adxValue: number;
  momentumDirection: TrendDirection;
  rsiStrength: number;
  macdMomentum: 'INCREASING' | 'DECREASING' | 'NEUTRAL';
  liquiditySweep: LiquiditySweep;
  fvgPresent: FVG;
  orderBlockConfirmed: OrderBlock;
  bullishStructurePercent: number;
  bearishStructurePercent: number;
  marketSession: MarketSession;
  volatility: Volatility;
  spreadStatus: SpreadStatus;
  similarSetupWinRate: number;
  riskScore: RiskScore;
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
