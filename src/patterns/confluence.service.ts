import { Injectable } from '@nestjs/common';
import { ConfluenceScore, MarketContext, PatternResult, PatternSignal, SignalStrength } from './candlestick.types';

@Injectable()
export class ConfluenceService {
  /**
   * Calculates the confluence score for a detected pattern based on market context.
   * @param pattern The detected candlestick pattern
   * @param context Market context (S/R, trend, volume, session)
   * @returns Confluence score and signal strength
   */
  calculateScore(pattern: PatternResult, context: MarketContext): ConfluenceScore {
    let score = 0;
    const factors: { name: string; points: number; maxPoints: number }[] = [];

    // 1. Candlestick pattern match (Base points)
    const patternPoints = 20;
    score += patternPoints;
    factors.push({ name: 'Pattern Match', points: patternPoints, maxPoints: 20 });

    // 2. Support/Resistance zone (25 pts)
    const isAtKeyLevel = (pattern.signal === PatternSignal.BULLISH && context.isAtSupport) ||
                         (pattern.signal === PatternSignal.BEARISH && context.isAtResistance);
    if (isAtKeyLevel) {
      score += 25;
      factors.push({ name: 'S/R Level', points: 25, maxPoints: 25 });
    }

    // 3. Aligned with market structure (20 pts)
    if (context.isMarketStructureAligned) {
      score += 20;
      factors.push({ name: 'Market Structure', points: 20, maxPoints: 20 });
    }

    // 4. Trend direction alignment (15 pts)
    if (context.isTrendAligned) {
      score += 15;
      factors.push({ name: 'Trend Alignment', points: 15, maxPoints: 15 });
    }

    // 5. Volume/liquidity spike (10 pts)
    if (context.isVolumeSpike) {
      score += 10;
      factors.push({ name: 'Volume Spike', points: 10, maxPoints: 10 });
    }

    // 6. Session timing (10 pts)
    if (context.isSessionTiming) {
      score += 10;
      factors.push({ name: 'Session Timing', points: 10, maxPoints: 10 });
    }

    // 7. Market-specific weight adjustments
    this.applyMarketWeights(pattern, context, factors, (pts) => score += pts);

    // Determine strength
    let strength = SignalStrength.LOW_PROBABILITY;
    if (score >= 75) strength = SignalStrength.HIGH_PROBABILITY;
    else if (score >= 50) strength = SignalStrength.MEDIUM_PROBABILITY;

    // ELITE_SIGNAL Check: Liquidity sweep + Pin/Engulfing + Key Level + Trend + Volume
    const isElite = context.isLiquiditySweep && 
                   (pattern.patternName.includes('PIN_BAR') || pattern.patternName.includes('ENGULFING')) &&
                   isAtKeyLevel && context.isTrendAligned && context.isVolumeSpike;
    
    if (isElite) {
      strength = SignalStrength.ELITE_SIGNAL;
      score = Math.max(score, 95); // Elite signals get boosted
    }

    return { score, strength, factors };
  }

  private applyMarketWeights(
    pattern: PatternResult,
    context: MarketContext,
    factors: any[],
    addPoints: (pts: number) => void,
  ) {
    const market = context.market.toUpperCase();
    const name = pattern.patternName;

    if (market.includes('XAU') || market.includes('GOLD')) {
      if (['HAMMER', 'PIN_BAR', 'INSIDE_BAR', 'ENGULFING'].some((p) => name.includes(p))) {
        addPoints(5);
        factors.push({ name: 'Gold Market Priority', points: 5, maxPoints: 5 });
      }
    } else if (market.includes('BTC')) {
      if (['ENGULFING', 'DOJI', 'PIN_BAR', 'STAR'].some((p) => name.includes(p))) {
        addPoints(5);
        factors.push({ name: 'BTC Market Priority', points: 5, maxPoints: 5 });
      }
    } else if (market.includes('NAS') || market.includes('100')) {
      if (['SHOOTING_STAR', 'ENGULFING', 'SOLDIERS', 'STAR'].some((p) => name.includes(p))) {
        addPoints(5);
        factors.push({ name: 'NAS Market Priority', points: 5, maxPoints: 5 });
      }
    }
  }
}
