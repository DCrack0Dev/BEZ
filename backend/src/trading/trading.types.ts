export enum TradingMode {
  LOCAL = 'LOCAL',
  BACKEND = 'BACKEND',
}

export enum SignalDirection {
  BULLISH = 'BULLISH',
  BEARISH = 'BEARISH',
  NEUTRAL = 'NEUTRAL',
}

export enum SignalStatus {
  PENDING = 'PENDING',
  SENT = 'SENT',
  EXECUTED = 'EXECUTED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

export interface TradingConfigEntity {
  userId: string;
  tradingMode: TradingMode;
  isActive: boolean;
  markets: string[];
  timeframe: string;
  updatedAt: Date;
}

export interface SignalEntity {
  id: string;
  userId: string;
  market: string;
  timeframe: string;
  patternName: string;
  signal: SignalDirection;
  confluenceScore: number;
  status: SignalStatus;
  executedAt: Date | null;
  executionResult: unknown;
  createdAt: Date;
}

export interface OhlcvCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface PatternResult {
  patternName: string;
  signal: SignalDirection;
  confluenceScore: number;
  factors: string[];
  timeframe: string;
  timestamp: number;
}

export interface ConfluenceScore {
  score: number;
  strength: 'LOW_PROBABILITY' | 'MEDIUM_PROBABILITY' | 'HIGH_PROBABILITY' | 'ELITE_SIGNAL';
  factors: Array<{ name: string; points: number; maxPoints: number }>;
}

export interface ScanMarketContext {
  market: string;
  timeframe: string;
  isAtSupport: boolean;
  isAtResistance: boolean;
  isTrendAligned: boolean;
  isMarketStructureAligned: boolean;
  isVolumeSpike: boolean;
  isSessionTiming: boolean;
  isLiquiditySweep?: boolean;
}

export interface UserSignalScanJobData {
  userId: string;
}

export interface UserJobStatus {
  userId: string;
  tradingMode: TradingMode;
  isActive: boolean;
  hasRepeatableJob: boolean;
}

/**
 * @placeholder - fill in from your .mph file before deploying
 * TODO: Replace with exact MT5 polling signal payload shape from your confirmed .mph file.
 */
export interface Mt5SignalPayloadPlaceholder {
  // Intentionally empty.
}

/**
 * @placeholder - fill in from your .mph file before deploying
 * TODO: Replace with exact MT5 execution callback request body shape from your confirmed .mph file.
 */
export interface Mt5ExecutionResultPlaceholder {
  // Intentionally empty.
}

/**
 * @placeholder - fill in from your .mph file before deploying
 * TODO: Replace with exact MT5 poll response shape from your confirmed .mph file.
 */
export interface Mt5PollResponsePlaceholder {
  // Intentionally empty.
}

