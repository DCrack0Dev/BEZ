export enum SignalStrength {
  LOW_PROBABILITY = 'LOW_PROBABILITY',
  MEDIUM_PROBABILITY = 'MEDIUM_PROBABILITY',
  HIGH_PROBABILITY = 'HIGH_PROBABILITY',
  ELITE_SIGNAL = 'ELITE_SIGNAL',
}

export enum PatternSignal {
  BULLISH = 'BULLISH',
  BEARISH = 'BEARISH',
  NEUTRAL = 'NEUTRAL',
}

export interface OHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface PatternResult {
  patternName: string;
  signal: PatternSignal;
  confluenceScore: number;
  factors: string[];
  timeframe: string;
  timestamp: number;
  price?: number;
}

export interface ConfluenceScore {
  score: number;
  strength: SignalStrength;
  factors: {
    name: string;
    points: number;
    maxPoints: number;
  }[];
}

export interface MarketContext {
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
