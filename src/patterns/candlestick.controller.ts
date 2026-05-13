import { Controller, Get, Param, Query } from '@nestjs/common';
import { CandlestickService } from './candlestick.service';
import { ConfluenceService } from './confluence.service';
import { OHLCV } from './candlestick.types';

@Controller('patterns')
export class CandlestickController {
  constructor(
    private readonly candlestickService: CandlestickService,
    private readonly confluenceService: ConfluenceService,
  ) {}

  /**
   * Returns the latest detected patterns for a market and timeframe.
   * Integration point for the strategy layer.
   * @param market e.g. 'BTC/USD', 'XAU/USD'
   * @param timeframe e.g. 'H1', 'H4', 'D1'
   */
  @Get(':market/:timeframe/latest')
  async getLatestPatterns(
    @Param('market') market: string,
    @Param('timeframe') timeframe: string,
    @Query() contextQuery: any,
  ) {
    // In a real implementation, you would fetch OHLCV from Redis or a DataProvider
    // For now, this is the entry point for the pattern recognition engine
    const candles: OHLCV[] = []; // Placeholder for actual market data

    const patterns = this.candlestickService.detectPatterns(candles, timeframe);

    const results = patterns.map((p) => {
      const confluence = this.confluenceService.calculateScore(p, {
        market,
        timeframe,
        isAtSupport: contextQuery.atSupport === 'true',
        isAtResistance: contextQuery.atResistance === 'true',
        isTrendAligned: contextQuery.trendAligned === 'true',
        isMarketStructureAligned: contextQuery.structureAligned === 'true',
        isVolumeSpike: contextQuery.volumeSpike === 'true',
        isSessionTiming: contextQuery.sessionTiming === 'true',
        isLiquiditySweep: contextQuery.liquiditySweep === 'true',
      });

      return {
        ...p,
        confluenceScore: confluence.score,
        strength: confluence.strength,
        factors: [...p.factors, ...confluence.factors.map((f) => f.name)],
      };
    });

    return results;
  }
}
