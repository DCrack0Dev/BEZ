import {
  FeatureSet,
  Candle,
  TrendDirection,
  MarketSession,
  Volatility,
  SpreadStatus,
  LiquiditySweep,
  FVG,
  OrderBlock,
  RiskScore,
  SwingPoint,
  FVGDetails,
  OrderBlockDetails,
  StructureType,
  NewsImpact,
} from '../types';
import { aiLogger } from '../logging';

const LONDON_START = 8;
const LONDON_END = 16;
const NEWYORK_START = 13;
const NEWYORK_END = 21;
const ASIA_START = 22;
const ASIA_END = 7;

export class FeatureEngineeringEngine {
  private historicalFeatures: FeatureSet[] = [];
  private readonly maxHistory = 2000;

  private calculateEMA(candles: Candle[], period: number, priceKey: 'close' | 'high' | 'low' | 'volume' = 'close'): number {
    if (candles.length < period) return 0;
    const k = 2 / (period + 1);
    const arr = [...candles];
    const startIdx = arr.length - period;
    let ema = arr.slice(startIdx).reduce((sum, c) => sum + (c as any)[priceKey], 0) / period;
    for (let i = startIdx - 1; i >= 0; i--) {
      ema = (arr[i] as any)[priceKey] * k + ema * (1 - k);
    }
    return ema;
  }

  private calculateSMA(candles: Candle[], period: number, priceKey: 'close' | 'high' | 'low' | 'volume' = 'close'): number {
    if (candles.length < period) return 0;
    const arr = candles.slice(-period);
    return arr.reduce((sum, c) => sum + (c as any)[priceKey], 0) / period;
  }

  private calculateRSI(candles: Candle[], period: number = 14): number {
    if (candles.length < period + 1) return 50;
    let gains = 0;
    let losses = 0;
    for (let i = candles.length - period; i < candles.length; i++) {
      const change = candles[i].close - candles[i - 1].close;
      if (change > 0) gains += change;
      else losses -= change;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  private calculateMACD(candles: Candle[], fastPeriod = 12, slowPeriod = 26, signalPeriod = 9): { macd: number; signal: number; histogram: number } {
    if (candles.length < slowPeriod + signalPeriod) return { macd: 0, signal: 0, histogram: 0 };
    const macdLine = this.calculateEMA(candles, fastPeriod) - this.calculateEMA(candles, slowPeriod);
    const signalLineCandles: Candle[] = [];
    for (let i = 0; i <= signalPeriod; i++) {
      const slice = candles.slice(0, candles.length - i);
      const macd = this.calculateEMA(slice, fastPeriod) - this.calculateEMA(slice, slowPeriod);
      signalLineCandles.unshift({ open: macd, high: macd, low: macd, close: macd, volume: 0, timestamp: 0 });
    }
    const signal = this.calculateEMA(signalLineCandles, signalPeriod);
    return {
      macd: macdLine,
      signal,
      histogram: macdLine - signal,
    };
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

    let plusDM = 0;
    let minusDM = 0;
    for (let i = candles.length - period; i < candles.length; i++) {
      if (i === 0) continue;
      const up = candles[i].high - candles[i - 1].high;
      const down = candles[i - 1].low - candles[i].low;
      plusDM += up > down && up > 0 ? up : 0;
      minusDM += down > up && down > 0 ? down : 0;
    }

    const avgPlusDM = plusDM / period;
    const avgMinusDM = minusDM / period;

    if (avgPlusDM === 0 && avgMinusDM === 0) return 0;
    if (atr === 0) return 0;

    const plusDI = (avgPlusDM / atr) * 100;
    const minusDI = (avgMinusDM / atr) * 100;
    const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;

    return Math.min(100, Math.max(0, dx));
  }

  private calculateVWAP(candles: Candle[]): number {
    if (candles.length === 0) return 0;
    let totalVolume = 0;
    let totalPV = 0;
    for (const c of candles) {
      const tp = (c.high + c.low + c.close) / 3;
      totalPV += tp * c.volume;
      totalVolume += c.volume;
    }
    return totalVolume > 0 ? totalPV / totalVolume : candles[candles.length - 1].close;
  }

  private calculateBollingerBands(candles: Candle[], period = 20, stdDev = 2): { upper: number; middle: number; lower: number } {
    if (candles.length < period) {
      const c = candles[candles.length - 1];
      return { upper: c.close, middle: c.close, lower: c.close };
    }
    const closes = candles.slice(-period).map((c) => c.close);
    const sma = closes.reduce((a, b) => a + b, 0) / period;
    const variance = closes.reduce((sum, v) => sum + (v - sma) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    return {
      upper: sma + stdDev * sd,
      middle: sma,
      lower: sma - stdDev * sd,
    };
  }

  private calculateCCI(candles: Candle[], period: number = 20): number {
    if (candles.length < period) return 0;
    const typicalPrices = candles.slice(-period).map((c) => (c.high + c.low + c.close) / 3);
    const sma = typicalPrices.reduce((a, b) => a + b, 0) / period;
    const meanDeviation = typicalPrices.reduce((a, tp) => a + Math.abs(tp - sma), 0) / period;
    if (meanDeviation === 0) return 0;
    const cci = (typicalPrices[typicalPrices.length - 1] - sma) / (0.015 * meanDeviation);
    return Math.min(200, Math.max(-200, cci));
  }

  private calculateWilliamsR(candles: Candle[], period: number = 14): number {
    if (candles.length < period) return -50;
    const recent = candles.slice(-period);
    const highestHigh = Math.max(...recent.map((c) => c.high));
    const lowestLow = Math.min(...recent.map((c) => c.low));
    const currentClose = recent[recent.length - 1].close;

    if (highestHigh === lowestLow) return -50;
    return -100 * ((highestHigh - currentClose) / (highestHigh - lowestLow));
  }

  private calculateSlope(values: number[]): number {
    if (values.length < 2) return 0;
    const n = values.length;
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumX2 = 0;
    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += values[i];
      sumXY += i * values[i];
      sumX2 += i * i;
    }
    const denom = n * sumX2 - sumX * sumX;
    if (denom === 0) return 0;
    const slope = (n * sumXY - sumX * sumY) / denom;
    return slope;
  }

  private detectSwings(candles: Candle[], swingLength: number = 5): { swingHighs: SwingPoint[]; swingLows: SwingPoint[] } {
    const swingHighs: SwingPoint[] = [];
    const swingLows: SwingPoint[] = [];

    for (let i = swingLength; i < candles.length - swingLength; i++) {
      const center = candles[i];
      let isHigh = true;
      let isLow = true;
      for (let j = 1; j <= swingLength; j++) {
        isHigh = isHigh && center.high > candles[i - j].high && center.high > candles[i + j].high;
        isLow = isLow && center.low < candles[i - j].low && center.low < candles[i + j].low;
      }
      if (isHigh) {
        swingHighs.push({
          price: center.high,
          timestamp: center.timestamp,
          strength: 1 + Math.min(5, Math.abs(candles[i - swingLength].close - center.high)),
        });
      }
      if (isLow) {
        swingLows.push({
          price: center.low,
          timestamp: center.timestamp,
          strength: 1 + Math.min(5, Math.abs(center.low - candles[i - swingLength].close)),
        });
      }
    }
    return { swingHighs, swingLows };
  }

  private getNearestLevels(swings: SwingPoint[], price: number, findBelow: boolean = false, findAbove: boolean = false): { nearest: number | undefined; distance: number } {
    let candidates = [...swings];
    if (findBelow) candidates = candidates.filter((s) => s.price < price);
    if (findAbove) candidates = candidates.filter((s) => s.price > price);
    candidates.sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price));
    if (candidates.length === 0) return { nearest: undefined, distance: Infinity };
    const nearest = candidates[0];
    return { nearest: nearest.price, distance: Math.abs(nearest.price - price) };
  }

  private detectSwingStructure(swingHighs: SwingPoint[], swingLows: SwingPoint[]): { type: 'HIGHER_HIGHS' | 'LOWER_LOWERS' | 'MIXED'; strength: number } {
    if (swingHighs.length < 2 || swingLows.length < 2) return { type: 'MIXED', strength: 0.3 };
    const recentHighs = swingHighs.slice(-3);
    const recentLows = swingLows.slice(-3);
    let hh = true;
    let hl = true;
    let lh = true;
    let ll = true;
    for (let i = 1; i < recentHighs.length; i++) {
      hh = hh && recentHighs[i].price > recentHighs[i - 1].price;
      lh = lh && recentHighs[i].price < recentHighs[i - 1].price;
    }
    for (let i = 1; i < recentLows.length; i++) {
      hl = hl && recentLows[i].price > recentLows[i - 1].price;
      ll = ll && recentLows[i].price < recentLows[i - 1].price;
    }

    if (hh && hl) return { type: 'HIGHER_HIGHS', strength: 0.85 };
    if (lh && ll) return { type: 'LOWER_LOWERS', strength: 0.85 };
    if (hh || hl) return { type: 'HIGHER_HIGHS', strength: 0.55 };
    if (lh || ll) return { type: 'LOWER_LOWERS', strength: 0.55 };
    return { type: 'MIXED', strength: 0.5 };
  }

  private detectFVG(candles: Candle[], pipSize: number): { type: FVG; details: FVGDetails; bullishPresent: boolean; bearishPresent: boolean; filledPercent: number; fvgStart: number; fvgEnd: number } {
    const fallback = { type: 'NONE' as FVG, details: { type: 'NONE', startPrice: 0, endPrice: 0, sizePips: 0, filledPercent: 0 }, bullishPresent: false, bearishPresent: false, filledPercent: 0, fvgStart: 0, fvgEnd: 0 };
    if (candles.length < 5) return fallback;
    const current = candles[candles.length - 1];
    const prev2 = candles[candles.length - 3];
    const prev3 = candles[candles.length - 4];

    if (prev2.low > prev3.high) {
      const gapStart = prev3.high;
      const gapEnd = prev2.low;
      const size = Math.max(0, gapEnd - gapStart);
      const filled = size > 0 ? Math.max(0, Math.min(size, current.close - gapStart)) : 0;
      const filledPct = size > 0 ? filled / size : 0;
      return {
        type: 'BULLISH',
        bullishPresent: true,
        bearishPresent: false,
        fvgStart: gapStart,
        fvgEnd: gapEnd,
        filledPercent: filledPct,
        details: {
          type: 'BULLISH',
          startPrice: gapStart,
          endPrice: gapEnd,
          sizePips: pipSize > 0 ? size / pipSize : 0,
          filledPercent: filledPct * 100,
        },
      };
    } else if (prev2.high < prev3.low) {
      const gapStart = prev2.high;
      const gapEnd = prev3.low;
      const size = Math.max(0, gapEnd - gapStart);
      const filled = size > 0 ? Math.max(0, Math.min(size, gapEnd - current.close)) : 0;
      const filledPct = size > 0 ? filled / size : 0;
      return {
        type: 'BEARISH',
        bullishPresent: false,
        bearishPresent: true,
        fvgStart: gapStart,
        fvgEnd: gapEnd,
        filledPercent: filledPct,
        details: {
          type: 'BEARISH',
          startPrice: gapStart,
          endPrice: gapEnd,
          sizePips: pipSize > 0 ? size / pipSize : 0,
          filledPercent: filledPct * 100,
        },
      };
    }
    return fallback;
  }

  private detectOrderBlocks(candles: Candle[], pipSize: number): {
    type: OrderBlock;
    details: OrderBlockDetails;
    bullishPresent: boolean;
    bearishPresent: boolean;
    zoneStart: number;
    zoneEnd: number;
  } {
    const fallback = {
      type: 'NONE' as OrderBlock,
      details: { type: 'NONE', top: 0, bottom: 0, displacementStrength: 0 },
      bullishPresent: false,
      bearishPresent: false,
      zoneStart: 0,
      zoneEnd: 0,
    };
    if (candles.length < 10) return fallback;
    const recent = candles.slice(-15);

    let bestOB = { type: 'NONE' as OrderBlock, top: 0, bottom: 0, strength: 0 };
    for (let i = recent.length - 2; i >= 2; i--) {
      const c = recent[i];
      const bodySize = Math.abs(c.close - c.open);
      const range = Math.max(0.00001, c.high - c.low);
      const bodyRatio = bodySize / range;
      if (bodyRatio > 0.55) {
        if (c.close > c.open && !bestOB.bullishPresent) {
          bestOB = { type: 'BULLISH', top: c.high, bottom: c.low, strength: bodyRatio };
          break;
        } else if (c.close < c.open && !bestOB.bearishPresent) {
          bestOB = { type: 'BEARISH', top: c.high, bottom: c.low, strength: bodyRatio };
          break;
        }
      }
    }

    return {
      type: bestOB.type,
      bullishPresent: bestOB.type === 'BULLISH',
      bearishPresent: bestOB.type === 'BEARISH',
      zoneStart: bestOB.bottom,
      zoneEnd: bestOB.top,
      details: {
        type: bestOB.type,
        top: bestOB.top,
        bottom: bestOB.bottom,
        displacementStrength: bestOB.strength,
      },
    };
  }

  private detectLiquiditySweep(
    candles: Candle[],
    swingHighs: SwingPoint[],
    swingLows: SwingPoint[],
    atr: number
  ): { sweep: LiquiditySweep; level: number } {
    if (candles.length < 10 || swingHighs.length === 0 || swingLows.length === 0 || atr === 0) {
      return { sweep: 'NONE', level: 0 };
    }
    const current = candles[candles.length - 1];
    const swingHigh = Math.max(...swingHighs.slice(-8).map((s) => s.price));
    const swingLow = Math.min(...swingLows.slice(-8).map((s) => s.price));
    const sweepThreshold = atr * 0.15;
    const retraceThreshold = atr * 0.1;

    let sweep: LiquiditySweep = 'NONE';
    let level = 0;
    if (current.high > swingHigh + sweepThreshold && current.close < swingHigh - retraceThreshold) {
      sweep = 'BEARISH';
      level = Math.min(1, (current.high - swingHigh) / atr);
    } else if (current.low < swingLow - sweepThreshold && current.close > swingLow + retraceThreshold) {
      sweep = 'BULLISH';
      level = Math.min(1, (swingLow - current.low) / atr);
    }
    return { sweep, level };
  }

  private detectPrevCandleRelationships(candles: Candle[], pipSize: number): {
    prevCandleBullish: boolean;
    prevCandleBearish: boolean;
    prevCandleSizeRatio: number | null;
    gapUp: boolean;
    gapDown: boolean;
    threeCandlePattern: 'THREE_WHITE_SOLDERS' | 'THREE_BLACK_CROWS' | 'THREE_INSIDE_UP' | 'THREE_INSIDE_DOWN' | 'DOJI' | null;
  } {
    const fallback = {
      prevCandleBullish: false,
      prevCandleBearish: false,
      prevCandleSizeRatio: null,
      gapUp: false,
      gapDown: false,
      threeCandlePattern: null,
    };
    if (candles.length < 2) return fallback;
    const prev = candles[candles.length - 2];
    const curr = candles[candles.length - 1];
    const prevBullish = prev.close > prev.open;
    const prevRange = Math.max(0.00001, prev.high - prev.low);
    const currRange = curr.high - curr.low;
    const gapUp = curr.open > prev.high + (pipSize > 0 ? pipSize * 0.5 : 0);
    const gapDown = curr.open < prev.low - (pipSize > 0 ? pipSize * 0.5 : 0);

    let pattern: typeof fallback.threeCandlePattern = null;
    if (candles.length >= 3) {
      const p3 = candles[candles.length - 3];
      const body = Math.abs(prev.close - prev.open) / prevRange;
      if (body < 0.1) pattern = 'DOJI';
      if (p3.close < p3.open && prevBullish && body > 0.6 && curr.close > prev.close && curr.close > p3.high) {
        pattern = 'THREE_INSIDE_UP';
      } else if (p3.close > p3.open && !prevBullish && body > 0.6 && curr.close < prev.close && curr.close < p3.low) {
        pattern = 'THREE_INSIDE_DOWN';
      } else if (candles.length >= 4) {
        const p4 = candles[candles.length - 4];
        const tws = [p4, p3, prev, curr].slice(-3);
        if (tws.every((c) => c.close > c.open)) pattern = 'THREE_WHITE_SOLDERS';
        else if (tws.every((c) => c.close < c.open)) pattern = 'THREE_BLACK_CROWS';
      }
    }

    return {
      prevCandleBullish: prevBullish,
      prevCandleBearish: !prevBullish,
      prevCandleSizeRatio: prevRange > 0 ? currRange / prevRange : 1,
      gapUp,
      gapDown,
      threeCandlePattern: pattern,
    };
  }

  private getMarketSession(timestamp: number): MarketSession {
    const hour = new Date(timestamp).getUTCHours();
    const london = hour >= LONDON_START && hour < LONDON_END;
    const ny = hour >= NEWYORK_START && hour < NEWYORK_END;
    if (london && ny) return 'OVERLAP';
    if (london) return 'LONDON';
    if (ny) return 'NEWYORK';
    return 'ASIA';
  }

  private normalize(value: number, min: number, max: number): number {
    if (min === max) return 0.5;
    return Math.max(0, Math.min(1, (value - min) / (max - min)));
  }

  private oneHot(value: string, possible: string[]): number[] {
    return possible.map((p) => (p === value ? 1 : 0));
  }

  private computeNormalizedWindow(candles: Candle[]): {
    normalizedOpen: number;
    normalizedHigh: number;
    normalizedLow: number;
    normalizedClose: number;
    normalizedVolume: number;
  } {
    const N = Math.min(100, candles.length);
    if (N < 2) return { normalizedOpen: 0.5, normalizedHigh: 0.5, normalizedLow: 0.5, normalizedClose: 0.5, normalizedVolume: 0.5 };
    const window = candles.slice(-N);
    const minP = Math.min(...window.map((c) => Math.min(c.open, c.high, c.low, c.close)));
    const maxP = Math.max(...window.map((c) => Math.max(c.open, c.high, c.low, c.close)));
    const minV = Math.min(...window.map((c) => c.volume));
    const maxV = Math.max(...window.map((c) => c.volume));
    const curr = candles[candles.length - 1];
    return {
      normalizedOpen: this.normalize(curr.open, minP, maxP),
      normalizedHigh: this.normalize(curr.high, minP, maxP),
      normalizedLow: this.normalize(curr.low, minP, maxP),
      normalizedClose: this.normalize(curr.close, minP, maxP),
      normalizedVolume: this.normalize(curr.volume, minV, maxV),
    };
  }

  public generateFeatures(
    symbol: string,
    timeframe: string,
    candles: Candle[],
    ema20: number,
    ema50: number,
    atr: number,
    spread: number,
    pipSize: number,
    candleId?: string
  ): FeatureSet & {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    ema100?: number;
    vwap: number;
    bbUpper: number;
    bbMiddle: number;
    bbLower: number;
    bbBandwidth?: number;
    bbPosition?: number;
    momentumStrength: number;
    liquidityLevel?: number;
    swingHigh?: number;
    swingLow?: number;
    swingStructure?: 'HIGHER_HIGHS' | 'LOWER_LOWERS' | 'MIXED';
    bullishOrderBlockPresent: boolean;
    bearishOrderBlockPresent: boolean;
    orderBlockZoneStart?: number;
    orderBlockZoneEnd?: number;
    bullishFvgPresent: boolean;
    bearishFvgPresent: boolean;
    fvgStart?: number;
    fvgEnd?: number;
    fvgFilledPercent?: number;
    distanceToSupport?: number;
    distanceToResistance?: number;
    prevCandleBullish: boolean;
    prevCandleBearish: boolean;
    prevCandleSizeRatio?: number;
    gapUp: boolean;
    gapDown: boolean;
    threeCandlePattern?: string;
    normalizedOpen?: number;
    normalizedHigh?: number;
    normalizedLow?: number;
    normalizedClose?: number;
    normalizedVolume?: number;
    macd?: number;
    macdSignal?: number;
    macdHistogram?: number;
  } {
    const currentCandle = candles[candles.length - 1];
    const timestamp = currentCandle.timestamp;

    const ema20Distance = (currentCandle.close - ema20) / Math.max(pipSize, 0.00001);
    const ema50Distance = (currentCandle.close - ema50) / Math.max(pipSize, 0.00001);
    const ema100 = candles.length >= 100 ? this.calculateEMA(candles, 100) : undefined;

    const ema20History: number[] = [];
    for (let i = 0; i < Math.min(20, candles.length); i++) {
      const slice = candles.slice(0, candles.length - i);
      if (slice.length >= 20) ema20History.unshift(this.calculateEMA(slice, 20));
    }
    const ema50History: number[] = [];
    for (let i = 0; i < Math.min(30, candles.length); i++) {
      const slice = candles.slice(0, candles.length - i);
      if (slice.length >= 50) ema50History.unshift(this.calculateEMA(slice, 50));
    }

    const slope20 = this.calculateSlope(ema20History.length >= 5 ? ema20History.slice(-5) : []);
    const slope50 = this.calculateSlope(ema50History.length >= 5 ? ema50History.slice(-5) : []);

    const rsi = this.calculateRSI(candles);
    const adx = this.calculateADX(candles);
    const cci = this.calculateCCI(candles);
    const williamsR = this.calculateWilliamsR(candles);
    const macdResult = this.calculateMACD(candles);
    const vwap = this.calculateVWAP(candles.length >= 24 ? candles.slice(-24) : candles);
    const bb = this.calculateBollingerBands(candles, 20, 2);

    const atrHistory: number[] = [];
    for (let i = 0; i < 20; i++) {
      const slice = candles.slice(0, candles.length - i);
      if (slice.length >= 15) atrHistory.unshift(this.calculateATR(slice));
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
    const momentumStrength = Math.min(1, Math.abs(rsi - 50) / 30 + (Math.abs(macdResult.macd) / Math.max(0.00001, atr || 1)) * 0.5);

    const macdMomentum: 'INCREASING' | 'DECREASING' | 'NEUTRAL' =
      candles.length > 30 ? (macdResult.histogram > 0 ? 'INCREASING' : 'DECREASING') : 'NEUTRAL';

    const { swingHighs, swingLows } = this.detectSwings(candles, 3);
    const lastSwH = swingHighs[swingHighs.length - 1];
    const lastSwL = swingLows[swingLows.length - 1];
    const nearestSupData = this.getNearestLevels(swingLows, currentCandle.close, true);
    const nearestResData = this.getNearestLevels(swingHighs, currentCandle.close, false, true);
    const swingStructure = this.detectSwingStructure(swingHighs, swingLows);

    const fvgData = this.detectFVG(candles, pipSize);
    const obData = this.detectOrderBlocks(candles, pipSize);
    const liq = this.detectLiquiditySweep(candles, swingHighs, swingLows, atr);
    const prev = this.detectPrevCandleRelationships(candles, pipSize);
    const norm = this.computeNormalizedWindow(candles);

    const bbRange = Math.max(0.00001, bb.upper - bb.lower);
    const bbBandwidth = bb.middle > 0 ? (bb.upper - bb.lower) / bb.middle : 0.01;
    const bbPosition = (currentCandle.close - bb.lower) / bbRange;

    const avgVolume = candles.length >= 20 ? candles.slice(-20).reduce((s, c) => s + c.volume, 0) / 20 : currentCandle.volume;
    const volumeRatio = avgVolume > 0 ? currentCandle.volume / avgVolume : 1;
    const newsImpact: NewsImpact = 'NONE';

    const marketSession = this.getMarketSession(timestamp);

    let riskScore: RiskScore = 'MEDIUM';
    if (volatility === 'EXTREME' || spreadStatus === 'EXTREME') riskScore = 'CRITICAL';
    else if (volatility === 'HIGH' || spreadStatus === 'WIDE') riskScore = 'HIGH';
    else if (adx > 30 && trendStrength > 0.6) riskScore = 'LOW';

    const bullishStructurePercent = trendDirection === 'BULLISH' ? 70 : 30;
    const bearishStructurePercent = 100 - bullishStructurePercent;

    const featureSet: FeatureSet & ReturnType<FeatureEngineeringEngine['generateFeatures']> = {
      timestamp,
      symbol,
      timeframe,

      open: currentCandle.open,
      high: currentCandle.high,
      low: currentCandle.low,
      close: currentCandle.close,
      volume: currentCandle.volume,

      trendStrength,
      trendDirection,
      ema20DistancePips: ema20Distance,
      ema50DistancePips: ema50Distance,
      adxValue: adx,
      slope20,
      slope50,
      ema100,
      vwap,

      momentumDirection,
      rsiStrength: rsi,
      macdMomentum,
      cciValue: cci,
      williamsR,
      macd: macdResult.macd,
      macdSignal: macdResult.signal,
      macdHistogram: macdResult.histogram,
      momentumStrength,

      atrRatio,
      volatility,
      bbPercentWidth: bbBandwidth,
      bbWidth: bbBandwidth,
      bbPosition,
      bbUpper: bb.upper,
      bbMiddle: bb.middle,
      bbLower: bb.lower,
      bbBandwidth,

      liquiditySweep: liq.sweep,
      liquidityLevel: liq.level,

      swingHighs,
      swingLows,
      swingHigh: lastSwH?.price,
      swingLow: lastSwL?.price,
      swingStructure: swingStructure.type,
      nearestSupport: nearestSupData.nearest,
      nearestResistance: nearestResData.nearest,
      distanceToSupport: pipSize > 0 ? nearestSupData.distance / pipSize : undefined,
      distanceToResistance: pipSize > 0 ? nearestResData.distance / pipSize : undefined,
      structureType: swingStructure.type === 'MIXED' ? 'RANGE' : (swingStructure.type as any),
      structureStrength: swingStructure.strength,

      fvgPresent: fvgData.type,
      fvgDetails: fvgData.details,
      bullishFvgPresent: fvgData.bullishPresent,
      bearishFvgPresent: fvgData.bearishPresent,
      fvgStart: fvgData.fvgStart,
      fvgEnd: fvgData.fvgEnd,
      fvgFilledPercent: fvgData.filledPercent,

      orderBlockConfirmed: obData.type,
      orderBlockDetails: obData.details,
      bullishOrderBlockPresent: obData.bullishPresent,
      bearishOrderBlockPresent: obData.bearishPresent,
      orderBlockZoneStart: obData.zoneStart,
      orderBlockZoneEnd: obData.zoneEnd,

      marketSession,

      prevCandlePattern: prev.threeCandlePattern || undefined,
      prevCandleBodyPct: undefined,
      prevCandleType: prev.threeCandlePattern || undefined,
      prevCandleBullish: prev.prevCandleBullish,
      prevCandleBearish: prev.prevCandleBearish,
      prevCandleSizeRatio: prev.prevCandleSizeRatio ?? undefined,
      gapUp: prev.gapUp,
      gapDown: prev.gapDown,
      threeCandlePattern: prev.threeCandlePattern || undefined,

      volumeRatio,
      newsImpact,

      normalizedFeatures: [],

      spreadStatus,
      riskScore,
      similarSetupWinRate: 0,
      bullishStructurePercent: bullishStructurePercent ?? 0,
      bearishStructurePercent: bearishStructurePercent ?? 0,

      normalizedOpen: norm.normalizedOpen,
      normalizedHigh: norm.normalizedHigh,
      normalizedLow: norm.normalizedLow,
      normalizedClose: norm.normalizedClose,
      normalizedVolume: norm.normalizedVolume,

      candleId,
    };

    featureSet.normalizedFeatures = [
      this.normalize(featureSet.trendStrength, 0, 1),
      ...this.oneHot(featureSet.trendDirection, ['NEUTRAL', 'BULLISH', 'BEARISH']),
      this.normalize(featureSet.ema20DistancePips, -100, 100),
      this.normalize(featureSet.ema50DistancePips, -100, 100),
      this.normalize(featureSet.adxValue, 0, 100),
      ...this.oneHot(featureSet.momentumDirection, ['NEUTRAL', 'BULLISH', 'BEARISH']),
      this.normalize(featureSet.rsiStrength, 0, 100),
      ...this.oneHot(featureSet.macdMomentum, ['NEUTRAL', 'INCREASING', 'DECREASING']),
      this.normalize(featureSet.cciValue || 0, -200, 200),
      this.normalize(featureSet.williamsR || -50, -100, 0),
      this.normalize(featureSet.atrRatio, 0, 3),
      ...this.oneHot(featureSet.volatility, ['LOW', 'MEDIUM', 'HIGH', 'EXTREME']),
      this.normalize(featureSet.bbPercentWidth || 0.2, 0.0, 1),
      this.normalize(featureSet.bbPosition || 0.5, 0, 1),
      ...this.oneHot(featureSet.liquiditySweep, ['NONE', 'BULLISH', 'BEARISH']),
      ...this.oneHot(featureSet.structureType || 'RANGE', ['RANGE', 'HH_HL', 'LH_LL']),
      ...this.oneHot(featureSet.fvgPresent, ['NONE', 'BULLISH', 'BEARISH']),
      ...this.oneHot(featureSet.orderBlockConfirmed, ['NONE', 'BULLISH', 'BEARISH']),
      ...this.oneHot(featureSet.marketSession, ['ASIA', 'LONDON', 'NEWYORK', 'OVERLAP']),
      featureSet.prevCandleBullish ? 1 : 0,
      featureSet.prevCandleBearish ? 1 : 0,
      this.normalize(featureSet.prevCandleSizeRatio || 1, 0, 3),
      featureSet.gapUp ? 1 : 0,
      featureSet.gapDown ? 1 : 0,
      featureSet.bullishFvgPresent ? 1 : 0,
      featureSet.bearishFvgPresent ? 1 : 0,
      featureSet.bullishOrderBlockPresent ? 1 : 0,
      featureSet.bearishOrderBlockPresent ? 1 : 0,
      featureSet.normalizedClose ?? 0.5,
      featureSet.normalizedVolume ?? 0.5,
      this.normalize(featureSet.liquidityLevel || 0, 0, 1),
      this.normalize(featureSet.momentumStrength || 0.5, 0, 1),
    ].flat();

    this.historicalFeatures.push(featureSet);
    if (this.historicalFeatures.length > this.maxHistory) {
      this.historicalFeatures.shift();
    }
    aiLogger.debug(`Generated features for ${symbol} timeframe ${timeframe}`);

    return featureSet;
  }
}
