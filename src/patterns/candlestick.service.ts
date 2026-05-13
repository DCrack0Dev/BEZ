import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OHLCV, PatternResult, PatternSignal } from './candlestick.types';

@Injectable()
export class CandlestickService {
  private readonly bodyRatioThreshold: number;

  constructor(private configService: ConfigService) {
    this.bodyRatioThreshold = this.configService.get<number>('CANDLE_BODY_RATIO_THRESHOLD', 0.3);
  }

  /**
   * Detects candlestick patterns in a given series of OHLCV data.
   * @param candles Array of OHLCV data, sorted by timestamp ascending (latest last)
   * @param timeframe The timeframe being analyzed
   * @returns Array of detected patterns
   */
  detectPatterns(candles: OHLCV[], timeframe: string): PatternResult[] {
    if (candles.length < 3) return [];

    const results: PatternResult[] = [];
    const current = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const prev2 = candles[candles.length - 3];

    // Single-candle patterns
    this.checkHammer(current, results, timeframe);
    this.checkShootingStar(current, results, timeframe);
    this.checkDoji(current, results, timeframe);
    this.checkPinBar(current, results, timeframe);

    // Two-candle patterns
    this.checkEngulfing(prev, current, results, timeframe);
    this.checkInsideBar(prev, current, results, timeframe);

    // Three-candle patterns
    this.checkMorningStar(prev2, prev, current, results, timeframe);
    this.checkEveningStar(prev2, prev, current, results, timeframe);
    this.checkThreeSoldiersCrows(prev2, prev, current, results, timeframe);

    return results;
  }

  private getCandleMetrics(c: OHLCV) {
    const range = Math.max(0.000001, c.high - c.low);
    const bodySize = Math.abs(c.close - c.open);
    const bodyRatio = bodySize / range;
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const isBullish = c.close > c.open;
    const isBearish = c.close < c.open;
    return { range, bodySize, bodyRatio, upperWick, lowerWick, isBullish, isBearish };
  }

  /** Hammer: Small body (≤30%) + lower wick ≥2× body size + minimal upper wick */
  private checkHammer(c: OHLCV, results: PatternResult[], tf: string) {
    const { bodyRatio, lowerWick, bodySize, upperWick } = this.getCandleMetrics(c);
    if (bodyRatio <= this.bodyRatioThreshold && lowerWick >= 2 * bodySize && upperWick <= bodySize * 0.2) {
      results.push(this.createResult('HAMMER', PatternSignal.BULLISH, tf, c.timestamp, ['Long lower wick', 'Small body']));
    }
  }

  /** Shooting Star: Small body + upper wick ≥2× body size + minimal lower wick */
  private checkShootingStar(c: OHLCV, results: PatternResult[], tf: string) {
    const { bodyRatio, upperWick, bodySize, lowerWick } = this.getCandleMetrics(c);
    if (bodyRatio <= this.bodyRatioThreshold && upperWick >= 2 * bodySize && lowerWick <= bodySize * 0.2) {
      results.push(this.createResult('SHOOTING_STAR', PatternSignal.BEARISH, tf, c.timestamp, ['Long upper wick', 'Small body']));
    }
  }

  /** Doji: Tiny/no body + wicks */
  private checkDoji(c: OHLCV, results: PatternResult[], tf: string) {
    const { bodySize, range, upperWick, lowerWick } = this.getCandleMetrics(c);
    if (bodySize <= range * 0.05) {
      if (lowerWick > upperWick * 3) {
        results.push(this.createResult('DRAGONFLY_DOJI', PatternSignal.BULLISH, tf, c.timestamp, ['Tiny body', 'Long lower wick']));
      } else if (upperWick > lowerWick * 3) {
        results.push(this.createResult('GRAVESTONE_DOJI', PatternSignal.BEARISH, tf, c.timestamp, ['Tiny body', 'Long upper wick']));
      } else {
        results.push(this.createResult('LONG_LEGGED_DOJI', PatternSignal.NEUTRAL, tf, c.timestamp, ['Tiny body', 'Equal wicks']));
      }
    }
  }

  /** Pin Bar: Long wick (≥2/3 of range) + tiny body */
  private checkPinBar(c: OHLCV, results: PatternResult[], tf: string) {
    const { range, bodySize, upperWick, lowerWick } = this.getCandleMetrics(c);
    if (bodySize <= range * 0.2) {
      if (lowerWick >= (2 / 3) * range) {
        results.push(this.createResult('PIN_BAR', PatternSignal.BULLISH, tf, c.timestamp, ['Bullish rejection', 'Long lower wick']));
      } else if (upperWick >= (2 / 3) * range) {
        results.push(this.createResult('PIN_BAR', PatternSignal.BEARISH, tf, c.timestamp, ['Bearish rejection', 'Long upper wick']));
      }
    }
  }

  /** Engulfing: Current body fully engulfs previous body */
  private checkEngulfing(prev: OHLCV, curr: OHLCV, results: PatternResult[], tf: string) {
    const p = this.getCandleMetrics(prev);
    const c = this.getCandleMetrics(curr);
    if (c.isBullish && p.isBearish && curr.close > prev.open && curr.open < prev.close) {
      results.push(this.createResult('BULLISH_ENGULFING', PatternSignal.BULLISH, tf, curr.timestamp, ['Bullish engulfs bearish']));
    } else if (c.isBearish && p.isBullish && curr.close < prev.open && curr.open > prev.close) {
      results.push(this.createResult('BEARISH_ENGULFING', PatternSignal.BEARISH, tf, curr.timestamp, ['Bearish engulfs bullish']));
    }
  }

  /** Inside Bar: Current range within previous range */
  private checkInsideBar(prev: OHLCV, curr: OHLCV, results: PatternResult[], tf: string) {
    if (curr.high <= prev.high && curr.low >= prev.low) {
      results.push(this.createResult('INSIDE_BAR', PatternSignal.NEUTRAL, tf, curr.timestamp, ['Compression', 'Inside range']));
    }
  }

  /** Morning Star: Bearish -> Small -> Bullish */
  private checkMorningStar(p2: OHLCV, p1: OHLCV, c: OHLCV, results: PatternResult[], tf: string) {
    const m2 = this.getCandleMetrics(p2);
    const m1 = this.getCandleMetrics(p1);
    const mc = this.getCandleMetrics(c);
    if (m2.isBearish && m1.bodyRatio <= 0.3 && mc.isBullish && c.close > (p2.open + p2.close) / 2) {
      results.push(this.createResult('MORNING_STAR', PatternSignal.BULLISH, tf, c.timestamp, ['Bearish reversal', 'Three-candle star']));
    }
  }

  /** Evening Star: Bullish -> Small -> Bearish */
  private checkEveningStar(p2: OHLCV, p1: OHLCV, c: OHLCV, results: PatternResult[], tf: string) {
    const m2 = this.getCandleMetrics(p2);
    const m1 = this.getCandleMetrics(p1);
    const mc = this.getCandleMetrics(c);
    if (m2.isBullish && m1.bodyRatio <= 0.3 && mc.isBearish && c.close < (p2.open + p2.close) / 2) {
      results.push(this.createResult('EVENING_STAR', PatternSignal.BEARISH, tf, c.timestamp, ['Bearish reversal', 'Three-candle star']));
    }
  }

  /** Three White Soldiers / Black Crows */
  private checkThreeSoldiersCrows(p2: OHLCV, p1: OHLCV, c: OHLCV, results: PatternResult[], tf: string) {
    const m2 = this.getCandleMetrics(p2);
    const m1 = this.getCandleMetrics(p1);
    const mc = this.getCandleMetrics(c);

    if (m2.isBullish && m1.isBullish && mc.isBullish && p1.close > p2.close && c.close > p1.close) {
      results.push(this.createResult('THREE_WHITE_SOLDIERS', PatternSignal.BULLISH, tf, c.timestamp, ['Strong institutional buying']));
    } else if (m2.isBearish && m1.isBearish && mc.isBearish && p1.close < p2.close && c.close < p1.close) {
      results.push(this.createResult('THREE_BLACK_CROWS', PatternSignal.BEARISH, tf, c.timestamp, ['Aggressive institutional selling']));
    }
  }

  private createResult(name: string, signal: PatternSignal, tf: string, ts: number, factors: string[]): PatternResult {
    return { patternName: name, signal, confluenceScore: 0, factors, timeframe: tf, timestamp: ts };
  }
}
