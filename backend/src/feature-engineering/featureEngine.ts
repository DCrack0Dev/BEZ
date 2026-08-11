import { Decimal } from 'decimal.js';
import { 
  FeatureSet as FeatureSetType, 
  Candle, 
  TrendDirection, 
  MarketSession, 
  Volatility, 
  SpreadStatus, 
  LiquiditySweep, 
  FVG, 
  OrderBlock, 
  RiskScore 
} from '../types';
import { aiLogger } from '../logging';

const LONDON_START = 8;
const LONDON_END = 16;
const NEWYORK_START = 13;
const NEWYORK_END = 21;
const ASIA_START = 22;
const ASIA_END = 7;

interface FVGDetails {
  type: 'BULLISH' | 'BEARISH' | 'NONE';
  startPrice: number;
  endPrice: number;
  sizePips: number;
  filledPercent: number;
}

interface OrderBlockDetails {
  type: 'BULLISH' | 'BEARISH' | 'NONE';
  top: number;
  bottom: number;
  displacementStrength: number;
}

interface SwingPoint {
  price: number;
  timestamp: number;
  strength: number;
}

type StructureType = 'HH_HL' | 'LH_LL' | 'RANGE';

interface EnhancedFeatureSet {
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
  
  liquiditySweep: LiquiditySweep;
  recentSweeps?: any[];
  
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
  poiZones?: any[];
  
  marketSession: MarketSession;
  
  prevCandlePattern?: string;
  prevCandleBodyPct?: number;
  prevCandleType?: string;
  
  normalizedFeatures: number[];
  
  spreadStatus: SpreadStatus;
  similarSetupWinRate: number;
  riskScore: RiskScore;
  bullishStructurePercent: number;
  bearishStructurePercent: number;
  candleId?: string;
}

export class FeatureEngineeringEngine {
  private historicalFeatures: EnhancedFeatureSet[] = [];
  private readonly maxHistory = 2000;

  private calculateEMA(candles: Candle[], period: number, priceKey: 'close' = 'close'): number {
    if (candles.length < period) return 0;
    const k = 2 / (period + 1);
    const arr = [...candles].slice(candles.length - period);
    let ema = arr.reduce((sum, c) => sum + c[priceKey], 0) / period;
    for (let i = candles.length - period - 1; i >= 0; i--) {
      ema = candles[i][priceKey] * k + ema * (1 - k);
    }
    return ema;
  }

  private calculateSMA(candles: Candle[], period: number, priceKey: 'close' = 'close'): number {
    if (candles.length < period) return 0;
    const arr = candles.slice(-period);
    return arr.reduce((sum, c) => sum + c[priceKey], 0) / period;
  }

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

  private calculateADX(candles: Candle[], period: number = 14): number {
    if (candles.length < period + 10) return 20;
    const atr = this.calculateATR(candles, period);
    
    let plusDM = 0, minusDM = 0;
    for (let i = candles.length - period; i < candles.length; i++) {
      if (i === 0) continue;
      const up = candles[i].high - candles[i-1].high;
      const down = candles[i-1].low - candles[i].low;
      plusDM += up > down && up > 0 ? up : 0;
      minusDM += down > up && down > 0 ? down : 0;
    }

    const avgPlusDM = plusDM / period;
    const avgMinusDM = minusDM / period;
    
    if (avgPlusDM === 0 && avgMinusDM === 0) return 0;
    
    const plusDI = (avgPlusDM / atr) * 100;
    const minusDI = (avgMinusDM / atr) * 100;
    const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
    
    return Math.min(100, Math.max(0, dx));
  }

  private calculateCCI(candles: Candle[], period: number = 20): number {
    if (candles.length < period) return 0;
    const typicalPrices = candles.slice(-period).map(c => (c.high + c.low + c.close) / 3);
    const sma = typicalPrices.reduce((a,b) => a + b, 0) / period;
    const meanDeviation = typicalPrices.reduce((a, tp) => a + Math.abs(tp - sma), 0) / period;
    if (meanDeviation === 0) return 0;
    const cci = (typicalPrices[typicalPrices.length - 1] - sma) / (0.015 * meanDeviation);
    return Math.min(200, Math.max(-200, cci));
  }

  private calculateWilliamsR(candles: Candle[], period: number = 14): number {
    if (candles.length < period) return -50;
    const recent = candles.slice(-period);
    const highestHigh = Math.max(...recent.map(c => c.high));
    const lowestLow = Math.min(...recent.map(c => c.low));
    const currentClose = recent[recent.length - 1].close;
    
    if (highestHigh === lowestLow) return -50;
    return -100 * ((highestHigh - currentClose) / (highestHigh - lowestLow));
  }

  private calculateSlope(values: number[]): number {
    if (values.length < 2) return 0;
    const n = values.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += values[i];
      sumXY += i * values[i];
      sumX2 += i * i;
    }
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    return slope;
  }

  private detectSwings(candles: Candle[], swingLength: number = 5): { swingHighs: SwingPoint[], swingLows: SwingPoint[] } {
    const swingHighs: SwingPoint[] = [];
    const swingLows: SwingPoint[] = [];

    for (let i = swingLength; i < candles.length - swingLength; i++) {
      const center = candles[i];
      let isHigh = true, isLow = true;
      for (let j = 1; j <= swingLength; j++) {
        isHigh = isHigh && center.high > candles[i - j].high && center.high > candles[i + j].high;
        isLow = isLow && center.low < candles[i - j].low && center.low < candles[i + j].low;
      }
      if (isHigh) {
        swingHighs.push({
          price: center.high,
          timestamp: center.timestamp,
          strength: 1 + Math.min(5, candles[i - swingLength].close - center.high)
        });
      }
      if (isLow) {
        swingLows.push({
          price: center.low,
          timestamp: center.timestamp,
          strength: 1 + Math.min(5, center.low - candles[i - swingLength].close)
        });
      }
    }
    return { swingHighs, swingLows };
  }

  private getNearestLevels(swings: SwingPoint[], price: number): { nearest: number | undefined, distance: number } {
    swings.sort((a,b) => a.price - b.price);
    let nearest: number | undefined = undefined;
    let minDistance = Infinity;
    for (const s of swings) {
      const d = Math.abs(s.price - price);
      if (d < minDistance) {
        minDistance = d;
        nearest = s.price;
      }
    }
    return { nearest, distance: minDistance };
  }

  private detectStructure(swingHighs: SwingPoint[], swingLows: SwingPoint[]): { type: StructureType, strength: number } {
    if (swingHighs.length < 3 || swingLows.length < 3) return { type: 'RANGE', strength: 0.3 };
    const recentHighs = swingHighs.slice(-3);
    const recentLows = swingLows.slice(-3);
    const hh = recentHighs[2].price > recentHighs[1].price && recentHighs[1].price > recentHighs[0].price;
    const hl = recentLows[2].price > recentLows[1].price && recentLows[1].price > recentLows[0].price;
    const lh = recentHighs[2].price < recentHighs[1].price && recentHighs[1].price < recentHighs[0].price;
    const ll = recentLows[2].price < recentLows[1].price && recentLows[1].price < recentLows[0].price;

    if (hh && hl) return { type: 'HH_HL', strength: 0.8 };
    if (lh && ll) return { type: 'LH_LL', strength: 0.8 };
    return { type: 'RANGE', strength: 0.5 };
  }

  private detectFVG(candles: Candle[], pipSize: number): { type: FVG, details: FVGDetails } {
    if (candles.length < 5) return { type: 'NONE', details: { type: 'NONE', startPrice: 0, endPrice: 0, sizePips: 0, filledPercent: 0 } };
    const current = candles[candles.length - 1];
    const prev2 = candles[candles.length - 3];
    const prev3 = candles[candles.length - 4];
    
    let fvgType: FVG = 'NONE';
    let details: FVGDetails = { type: 'NONE', startPrice: 0, endPrice: 0, sizePips: 0, filledPercent: 0 };

    if (prev2.low > prev3.high) {
      fvgType = 'BULLISH';
      const gapStart = prev3.high;
      const gapEnd = prev2.low;
      const size = gapEnd - gapStart;
      const filled = Math.max(0, current.low - gapStart);
      details = { type: 'BULLISH', startPrice: gapStart, endPrice: gapEnd, sizePips: size / pipSize, filledPercent: Math.min(100, (filled / size) * 100) };
    } else if (prev2.high < prev3.low) {
      fvgType = 'BEARISH';
      const gapStart = prev3.low;
      const gapEnd = prev2.high;
      const size = gapStart - gapEnd;
      const filled = Math.max(0, gapEnd - current.high);
      details = { type: 'BEARISH', startPrice: gapEnd, endPrice: gapStart, sizePips: size / pipSize, filledPercent: Math.min(100, (filled / size) * 100) };
    }
    return { type: fvgType, details };
  }

  private detectOrderBlocks(candles: Candle[], pipSize: number): { type: OrderBlock, details: OrderBlockDetails } {
    if (candles.length < 10) return { type: 'NONE', details: { type: 'NONE', top:0, bottom:0, displacementStrength: 0 } };
    const recent = candles.slice(-10);

    let bestOB = { type: 'NONE' as OrderBlock, top: 0, bottom:0, strength: 0 };
    for (let i = 0; i < recent.length - 2; i++) {
      const c = recent[i];
      const bodySize = Math.abs(c.close - c.open);
      const range = c.high - c.low;
      if (bodySize / range > 0.7) {
        if (c.close > c.open) { // Bullish order block
          bestOB = { type: 'BULLISH', top: c.high, bottom: c.low, strength: bodySize / range };
        } else if (c.close < c.open) { // Bearish
          bestOB = { type: 'BEARISH', top: c.high, bottom: c.low, strength: bodySize / range };
        }
      }
    }
    return { type: bestOB.type, details: { type: bestOB.type, top: bestOB.top, bottom: bestOB.bottom, displacementStrength: bestOB.strength } };
  }

  private detectLiquiditySweep(candles: Candle[], swingHighs: SwingPoint[], swingLows: SwingPoint[]): LiquiditySweep {
    if (candles.length < 10) return 'NONE';
    const current = candles[candles.length - 1];
    if (swingHighs.length === 0 || swingLows.length === 0) return 'NONE';
    const swingHigh = Math.max(...swingHighs.slice(-5).map(s => s.price));
    const swingLow = Math.min(...swingLows.slice(-5).map(s => s.price));
    const range = swingHigh - swingLow;
    if (current.high > swingHigh && current.close < swingHigh - range / 10) return 'BEARISH';
    if (current.low < swingLow && current.close > swingLow + range / 10) return 'BULLISH';
    return 'NONE';
  }

  private detectCandlePatterns(candles: Candle[]): { type: string, bodyPct: number, pattern: string } {
    if (candles.length < 2) return { type: 'DOJI', bodyPct: 0.0, pattern: 'NONE' };
    const c = candles[candles.length - 2];
    const range = c.high - c.low;
    const bodySize = Math.abs(c.close - c.open);
    const upper = c.high - Math.max(c.open, c.close);
    const lower = Math.min(c.open, c.close) - c.low;

    const bodyPct = range > 0 ? bodySize / range : 0;
    let type = 'DOJI';
    let pattern = 'NONE';

    if (bodyPct > 0.9) type = 'MARUBOZU';
    else if (bodyPct < 0.1) type = 'DOJI';
    else if (lower > upper * 2 && upper < bodySize) type = 'HAMMER';
    else if (upper > lower * 2 && lower < bodySize) type = 'SHOOTING_STAR';

    if (candles.length >= 3) {
      const prev1 = candles[candles.length - 3];
      if (c.close > prev1.high && prev1.close < prev1.open) pattern = 'BULLISH_ENGULFING';
      else if (c.close < prev1.low && prev1.close > prev1.open) pattern = 'BEARISH_ENGULFING';
    }

    return { type, bodyPct, pattern };
  }

  private getMarketSession(timestamp: number): MarketSession {
    const hour = new Date(timestamp).getUTCHours();
    if (hour >= NEWYORK_START && hour < LONDON_END) return 'OVERLAP';
    if (hour >= LONDON_START && hour < LONDON_END) return 'LONDON';
    if (hour >= NEWYORK_START && hour < NEWYORK_END) return 'NEWYORK';
    return 'ASIA';
  }

  private normalizeFeatures(raw: EnhancedFeatureSet): number[] {
    return [
      this.normalize(raw.trendStrength, 0, 1),
      ...this.oneHot(raw.trendDirection, ['NEUTRAL', 'BULLISH', 'BEARISH']),
      this.normalize(raw.ema20DistancePips, -100, 100),
      this.normalize(raw.ema50DistancePips, -100, 100),
      this.normalize(raw.adxValue, 0, 100),
      ...this.oneHot(raw.momentumDirection, ['NEUTRAL', 'BULLISH', 'BEARISH']),
      this.normalize(raw.rsiStrength, 0, 100),
      ...this.oneHot(raw.macdMomentum, ['NEUTRAL', 'INCREASING', 'DECREASING']),
      this.normalize(raw.cciValue || 0, -200, 200),
      this.normalize(raw.williamsR || -50, -100, 0),
      this.normalize(raw.atrRatio, 0, 3),
      ...this.oneHot(raw.volatility, ['LOW', 'MEDIUM', 'HIGH', 'EXTREME']),
      this.normalize(raw.bbPercentWidth || 0.2, 0.0, 1),
      this.normalize(raw.bbPosition || 0.5, 0, 1),
      ...this.oneHot(raw.liquiditySweep, ['NONE', 'BULLISH', 'BEARISH']),
      ...this.oneHot(raw.structureType || 'RANGE', ['RANGE', 'HH_HL', 'LH_LL']),
      ...this.oneHot(raw.fvgPresent, ['NONE', 'BULLISH', 'BEARISH']),
      ...this.oneHot(raw.orderBlockConfirmed, ['NONE', 'BULLISH', 'BEARISH']),
      ...this.oneHot(raw.marketSession, ['ASIA', 'LONDON', 'NEWYORK', 'OVERLAP']),
      ...this.oneHot(raw.prevCandleType || 'DOJI', ['DOJI', 'MARUBOZU', 'HAMMER', 'SHOOTING_STAR', 'ENGULFING']),
      this.normalize(raw.prevCandleBodyPct || 0.5, 0, 1)
    ].flat();
  }

  private normalize(value: number, min: number, max: number): number {
    if (min === max) return 0.5;
    return Math.max(0, Math.min(1, (value - min) / (max - min)));
  }

  private oneHot(value: string, possible: string[]): number[] {
    return possible.map(p => p === value ? 1 : 0);
  }

  public generateFeatures(
    symbol: string,
    timeframe: string,
    candles: Candle[],
    ema20: number,
    ema50: number,
    atr: number,
    spread: number,
    pipSize: number
  ): EnhancedFeatureSet {
    const currentCandle = candles[candles.length - 1];
    const timestamp = currentCandle.timestamp;

    const ema20Distance = new Decimal(currentCandle.close).sub(ema20).div(pipSize).toNumber();
    const ema50Distance = new Decimal(currentCandle.close).sub(ema50).div(pipSize).toNumber();
    const ema20History = candles.slice(-20).map((_, i) => {
        const slice = candles.slice(0, candles.length - i);
        if (slice.length >= 20) return this.calculateEMA(slice, 20);
        return 0;
    }).filter(v => v > 0);
    const ema50History = candles.slice(-50).map((_, i) => {
        const slice = candles.slice(0, candles.length - i);
        if (slice.length >= 50) return this.calculateEMA(slice, 50);
        return 0;
    }).filter(v => v > 0);

    const slope20 = this.calculateSlope(ema20History.length >= 5 ? ema20History.slice(-5) : []);
    const slope50 = this.calculateSlope(ema50History.length >= 5 ? ema50History.slice(-5) : []);

    const rsi = this.calculateRSI(candles);
    const adx = this.calculateADX(candles);
    const cci = this.calculateCCI(candles);
    const williamsR = this.calculateWilliamsR(candles);

    const atrHistory = [];
    for (let i = 0; i < 20; i++) {
      const slice = candles.slice(0, candles.length - i);
      if (slice.length >= 15) atrHistory.push(this.calculateATR(slice));
    }
    const avgAtr = atrHistory.length > 0 ? atrHistory.reduce((a, b) => a + b, 0) / atrHistory.length : atr;
    const atrRatio = avgAtr > 0 ? atr / avgAtr : 1;

    let volatility: Volatility = 'MEDIUM';
    if (atrRatio > 2) volatility = 'EXTREME';
    else if (atrRatio > 1.3) volatility = 'HIGH';
    else if (atrRatio < 0.7) volatility = 'LOW';

    let spreadStatus: SpreadStatus = 'NORMAL';
    if (spread > pipSize * 5) spreadStatus = 'EXTREME';
    else if (spread > pipSize * 2) spreadStatus = 'WIDE';

    let trendStrength = 0.5;
    let trendDirection: TrendDirection = 'NEUTRAL';
    if (ema20 > ema50 && adx > 25) {
      trendStrength = Math.min(1, adx / 50);
      trendDirection = 'BULLISH';
    } else if (ema20 < ema50 && adx > 25) {
      trendStrength = Math.min(1, adx / 50);
      trendDirection = 'BEARISH';
    }

    let momentumDirection: TrendDirection = 'NEUTRAL';
    if (rsi > 60) momentumDirection = 'BULLISH';
    else if (rsi < 40) momentumDirection = 'BEARISH';

    const macdMomentum = (candles.length > 30) ? 
      (candles[candles.length - 1].close > candles[candles.length - 3].close ? 'INCREASING' : 'DECREASING') : 'NEUTRAL';

    const { swingHighs, swingLows } = this.detectSwings(candles, 3);
    const nearestResData = this.getNearestLevels(swingHighs, currentCandle.close);
    const nearestSupData = this.getNearestLevels(swingLows, currentCandle.close);
    const structure = this.detectStructure(swingHighs, swingLows);

    const fvgData = this.detectFVG(candles, pipSize);
    const obData = this.detectOrderBlocks(candles, pipSize);
    const sweep = this.detectLiquiditySweep(candles, swingHighs, swingLows);
    const candleData = this.detectCandlePatterns(candles);

    const range = currentCandle.high - currentCandle.low;
    const bbPercentWidth = atrHistory.length > 1 ? (atr / range) : 0.2;
    const bbPosition = range > 0 ? (currentCandle.close - currentCandle.low) / range : 0.5;

    const marketSession = this.getMarketSession(timestamp);

    let riskScore: RiskScore = 'MEDIUM';
    if (volatility === 'EXTREME' || spreadStatus === 'EXTREME') riskScore = 'CRITICAL';
    else if (volatility === 'HIGH' || spreadStatus === 'WIDE') riskScore = 'HIGH';
    else if (adx > 30 && trendStrength > 0.6) riskScore = 'LOW';

    const bullishStructurePercent = trendDirection === 'BULLISH' ? 70 : 30;
    const bearishStructurePercent = 100 - bullishStructurePercent;

    const featureSet: EnhancedFeatureSet = {
      timestamp,
      symbol,
      timeframe,
      
      trendStrength,
      trendDirection,
      ema20DistancePips: ema20Distance,
      ema50DistancePips: ema50Distance,
      adxValue: adx,
      slope20,
      slope50,
      
      momentumDirection,
      rsiStrength: rsi,
      macdMomentum,
      cciValue: cci,
      williamsR,
      
      atrRatio,
      volatility,
      bbPercentWidth,
      bbPosition,
      
      liquiditySweep: sweep,
      recentSweeps: [],
      
      swingHighs,
      swingLows,
      nearestSupport: nearestSupData.nearest,
      nearestResistance: nearestResData.nearest,
      structureType: structure.type,
      structureStrength: structure.strength,
      
      fvgPresent: fvgData.type,
      fvgDetails: fvgData.details,
      orderBlockConfirmed: obData.type,
      orderBlockDetails: obData.details,
      poiZones: [],
      
      marketSession,
      
      prevCandlePattern: candleData.pattern,
      prevCandleBodyPct: candleData.bodyPct,
      prevCandleType: candleData.type,
      
      normalizedFeatures: [],
      
      spreadStatus,
      riskScore,
      similarSetupWinRate: 0,
      bullishStructurePercent: bullishStructurePercent ?? 0,
      bearishStructurePercent: bearishStructurePercent ?? 0,
    };

    featureSet.normalizedFeatures = this.normalizeFeatures(featureSet);

    this.historicalFeatures.push(featureSet);
    if (this.historicalFeatures.length > this.maxHistory) {
      this.historicalFeatures.shift();
    }
    aiLogger.debug(`Generated features for ${symbol} timeframe ${timeframe}`);

    return featureSet;
  }
}
