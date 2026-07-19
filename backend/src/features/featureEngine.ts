import { Decimal } from 'decimal.js';

/**
 * Feature Engineering Engine
 * Converts raw market data into structured, AI-friendly features
 */

export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
}

export interface FeatureSet {
  timestamp: number;
  symbol: string;
  
  // Trend Features
  trendStrength: number; // 0-1
  trendDirection: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  ema20DistancePips: number;
  ema50DistancePips: number;
  atrRatio: number;
  adxValue: number; // 0-100
  
  // Momentum Features
  momentumDirection: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  rsiStrength: number; // 0-100
  macdMomentum: 'INCREASING' | 'DECREASING' | 'NEUTRAL';
  
  // Structural Features
  liquiditySweep: 'BULLISH' | 'BEARISH' | 'NONE';
  fvgPresent: 'BULLISH' | 'BEARISH' | 'NONE';
  orderBlockConfirmed: 'BULLISH' | 'BEARISH' | 'NONE';
  bullishStructurePercent: number;
  bearishStructurePercent: number;
  
  // Market Context
  marketSession: 'LONDON' | 'NEWYORK' | 'ASIA' | 'OVERLAP';
  volatility: 'LOW' | 'MEDIUM' | 'HIGH' | 'EXTREME';
  spreadStatus: 'NORMAL' | 'WIDE' | 'EXTREME';
  
  // Historical Context
  similarSetupWinRate: number; // 0-1
  riskScore: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

const LONDON_START = 8; // UTC
const LONDON_END = 16;
const NEWYORK_START = 13;
const NEWYORK_END = 21;
const ASIA_START = 22;
const ASIA_END = 7;

export class FeatureEngineeringEngine {
  private historicalFeatures: FeatureSet[] = [];
  private readonly maxHistory = 1000;

  /**
   * Calculate EMA (Exponential Moving Average)
   */
  private calculateEMA(candles: Candle[], period: number): number {
    if (candles.length < period) return 0;
    const k = 2 / (period + 1);
    let ema = candles.slice(candles.length - period, candles.length)
      .reduce((sum, c) => sum + c.close, 0) / period;
    for (let i = candles.length - period - 1; i >= 0; i--) {
      ema = candles[i].close * k + ema * (1 - k);
    }
    return ema;
  }

  /**
   * Calculate RSI (Relative Strength Index)
   */
  private calculateRSI(candles: Candle[], period: number = 14): number {
    if (candles.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = candles.length - period; i < candles.length; i++) {
      const change = candles[i].close - candles[i - 1].close;
      if (change > 0) gains += change;
      else losses -= change;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  }

  /**
   * Calculate ATR (Average True Range)
   */
  private calculateATR(candles: Candle[], period: number = 14): number {
    if (candles.length < period + 1) return 0;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
      const prev = candles[i - 1];
      const tr = Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - prev.close),
        Math.abs(candles[i].low - prev.close)
      );
      trs.push(tr);
    }
    const atr = trs.slice(-period).reduce((sum, tr) => sum + tr, 0) / period;
    return atr;
  }

  /**
   * Calculate ADX (Average Directional Index) - basic version
   */
  private calculateADX(candles: Candle[], period: number = 14): number {
    if (candles.length < period + 10) return 20;
    // Simplified ADX estimation
    const atr = this.calculateATR(candles, period);
    const recentMoves = candles.slice(-20).map(c => c.high - c.low);
    const avgRange = recentMoves.reduce((a, b) => a + b, 0) / recentMoves.length;
    if (atr === 0) return 20;
    return Math.min(100, Math.max(0, (avgRange / atr) * 25));
  }

  /**
   * Detect Liquidity Sweep
   */
  private detectLiquiditySweep(candles: Candle[]): 'BULLISH' | 'BEARISH' | 'NONE' {
    if (candles.length < 10) return 'NONE';
    const current = candles[candles.length - 1];
    const prior = candles[candles.length - 2];
    const swingHigh = Math.max(...candles.slice(-20, -2).map(c => c.high));
    const swingLow = Math.min(...candles.slice(-20, -2).map(c => c.low));

    if (current.high > swingHigh && current.close < swingHigh) {
      return 'BEARISH';
    }
    if (current.low < swingLow && current.close > swingLow) {
      return 'BULLISH';
    }
    return 'NONE';
  }

  /**
   * Detect FVG (Fair Value Gap)
   */
  private detectFVG(candles: Candle[]): 'BULLISH' | 'BEARISH' | 'NONE' {
    if (candles.length < 5) return 'NONE';
    const prev = candles[candles.length - 2];
    const prev2 = candles[candles.length - 3];
    const prev3 = candles[candles.length - 4];

    if (prev2.low > prev3.high) {
      return 'BULLISH';
    }
    if (prev2.high < prev3.low) {
      return 'BEARISH';
    }
    return 'NONE';
  }

  /**
   * Detect Order Blocks
   */
  private detectOrderBlocks(candles: Candle[]): 'BULLISH' | 'BEARISH' | 'NONE' {
    if (candles.length < 10) return 'NONE';
    const recent = candles.slice(-5);
    let strongBearish = 0, strongBullish = 0;
    recent.forEach(c => {
      const body = Math.abs(c.close - c.open);
      const range = c.high - c.low;
      if (body / range > 0.7) {
        if (c.close > c.open) strongBullish++;
        else strongBearish++;
      }
    });
    if (strongBullish >= 2) return 'BULLISH';
    if (strongBearish >= 2) return 'BEARISH';
    return 'NONE';
  }

  /**
   * Determine Market Session from UTC timestamp
   */
  private getMarketSession(timestamp: number): FeatureSet['marketSession'] {
    const hour = new Date(timestamp).getUTCHours();
    if (hour >= NEWYORK_START && hour < LONDON_END) {
      return 'OVERLAP';
    }
    if (hour >= LONDON_START && hour < LONDON_END) {
      return 'LONDON';
    }
    if (hour >= NEWYORK_START && hour < NEWYORK_END) {
      return 'NEWYORK';
    }
    return 'ASIA';
  }

  /**
   * Calculate similar setup win rate from history
   */
  private calculateSimilarSetupWinRate(features: Partial<FeatureSet>): number {
    if (this.historicalFeatures.length < 50) return 0.5; // 50% default

    // Find similar setups
    const similar = this.historicalFeatures.filter(f => 
      f.trendDirection === features.trendDirection &&
      f.marketSession === features.marketSession &&
      f.volatility === features.volatility &&
      Math.abs(f.rsiStrength - (features.rsiStrength || 50)) < 20
    );

    if (similar.length < 10) return 0.5;
    return 0.5; // Placeholder until we have actual results stored
  }

  /**
   * Generate complete FeatureSet from raw data
   */
  public generateFeatures(
    symbol: string,
    candles: Candle[],
    ema20: number,
    ema50: number,
    atr: number,
    spread: number,
    pipSize: number
  ): FeatureSet {
    const currentCandle = candles[candles.length - 1];
    const timestamp = currentCandle.timestamp;

    const ema20Distance = new Decimal(currentCandle.close).sub(ema20).div(pipSize).toNumber();
    const ema50Distance = new Decimal(currentCandle.close).sub(ema50).div(pipSize).toNumber();

    const rsi = this.calculateRSI(candles);
    const adx = this.calculateADX(candles);

    const atrHistory = [];
    for (let i = 0; i < 20; i++) {
      const slice = candles.slice(0, candles.length - i);
      if (slice.length >= 15) {
        atrHistory.push(this.calculateATR(slice));
      }
    }
    const avgAtr = atrHistory.length > 0 ? atrHistory.reduce((a, b) => a + b, 0) / atrHistory.length : atr;
    const atrRatio = avgAtr > 0 ? atr / avgAtr : 1;

    let volatility: FeatureSet['volatility'] = 'MEDIUM';
    if (atrRatio > 2) volatility = 'EXTREME';
    else if (atrRatio > 1.3) volatility = 'HIGH';
    else if (atrRatio < 0.7) volatility = 'LOW';

    let spreadStatus: FeatureSet['spreadStatus'] = 'NORMAL';
    if (spread > pipSize * 5) spreadStatus = 'EXTREME';
    else if (spread > pipSize * 2) spreadStatus = 'WIDE';

    let trendStrength = 0.5;
    let trendDirection: FeatureSet['trendDirection'] = 'NEUTRAL';
    if (ema20 > ema50 && adx > 25) {
      trendStrength = Math.min(1, adx / 50);
      trendDirection = 'BULLISH';
    } else if (ema20 < ema50 && adx > 25) {
      trendStrength = Math.min(1, adx / 50);
      trendDirection = 'BEARISH';
    }

    let momentumDirection: FeatureSet['momentumDirection'] = 'NEUTRAL';
    if (rsi > 60) momentumDirection = 'BULLISH';
    else if (rsi < 40) momentumDirection = 'BEARISH';

    const macdMomentum = (candles.length > 30) ? 
      (candles[candles.length - 1].close > candles[candles.length - 3].close ? 'INCREASING' : 'DECREASING') 
      : 'NEUTRAL';

    const liquiditySweep = this.detectLiquiditySweep(candles);
    const fvgPresent = this.detectFVG(candles);
    const orderBlockConfirmed = this.detectOrderBlocks(candles);

    const structurePercent = 0.5; // Placeholder
    const bullishStructurePercent = trendDirection === 'BULLISH' ? 70 : 30;
    const bearishStructurePercent = 100 - bullishStructurePercent;

    const marketSession = this.getMarketSession(timestamp);

    const partialFeatures: Partial<FeatureSet> = {
      trendDirection,
      marketSession,
      volatility,
      rsiStrength: rsi
    };
    const similarSetupWinRate = this.calculateSimilarSetupWinRate(partialFeatures);

    let riskScore: FeatureSet['riskScore'] = 'MEDIUM';
    if (volatility === 'EXTREME' || spreadStatus === 'EXTREME') riskScore = 'CRITICAL';
    else if (volatility === 'HIGH' || spreadStatus === 'WIDE') riskScore = 'HIGH';
    else if (adx > 30 && trendStrength > 0.6) riskScore = 'LOW';

    const featureSet: FeatureSet = {
      timestamp,
      symbol,
      trendStrength,
      trendDirection,
      ema20DistancePips: ema20Distance,
      ema50DistancePips: ema50Distance,
      atrRatio,
      adxValue: adx,
      momentumDirection,
      rsiStrength: rsi,
      macdMomentum,
      liquiditySweep,
      fvgPresent,
      orderBlockConfirmed,
      bullishStructurePercent,
      bearishStructurePercent,
      marketSession,
      volatility,
      spreadStatus,
      similarSetupWinRate,
      riskScore
    };

    this.historicalFeatures.push(featureSet);
    if (this.historicalFeatures.length > this.maxHistory) {
      this.historicalFeatures.shift();
    }

    return featureSet;
  }
}
