import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { CandlestickService } from '../patterns/candlestick.service';
import { ConfluenceService } from '../patterns/confluence.service';
import { TradingGateway } from './trading.gateway';
import {
  OhlcvCandle,
  ScanMarketContext,
  SignalDirection,
  SignalStatus,
  TradingMode,
  UserSignalScanJobData,
} from './trading.types';

@Injectable()
@Processor('trading-signal-scan')
export class TradingJobProcessor extends WorkerHost implements OnApplicationShutdown {
  private readonly logger = new Logger(TradingJobProcessor.name);
  private readonly redis: Redis;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly candlestickService: CandlestickService,
    private readonly confluenceService: ConfluenceService,
    private readonly tradingGateway: TradingGateway,
  ) {
    super();
    const redisUrl = this.configService.get<string>('REDIS_URL');
    this.redis = new Redis(redisUrl ?? '');
  }

  /**
   * Executes periodic signal scan for one user.
   */
  async process(job: Job<UserSignalScanJobData>): Promise<void> {
    const { userId } = job.data;
    const lockKey = `trading:scan-lock:${userId}`;
    const lockAcquired = await this.redis.set(lockKey, '1', 'EX', 55, 'NX');
    if (!lockAcquired) return;

    try {
      const tradingConfig = await this.prisma.tradingConfig.findUnique({
        where: { userId },
      });
      if (!tradingConfig || tradingConfig.tradingMode !== TradingMode.BACKEND || !tradingConfig.isActive) return;

      const threshold = this.configService.get<number>('CONFLUENCE_THRESHOLD', 75);
      const cacheTtl = this.configService.get<number>('SIGNAL_CACHE_TTL_SECONDS', 60);

      for (const market of tradingConfig.markets) {
        const candles = await this.fetchLatestCandles(market, tradingConfig.timeframe);
        if (!candles.length) continue;

        const patterns = this.candlestickService.detectPatterns(candles, market);
        for (const pattern of patterns) {
          const context = this.buildMarketContext(market, tradingConfig.timeframe, candles);
          const score = this.confluenceService.score(pattern, context);
          if (score.score < threshold) continue;

          const createdSignal = await this.prisma.signal.create({
            data: {
              userId,
              market,
              timeframe: tradingConfig.timeframe,
              patternName: pattern.patternName,
              signal: pattern.signal as SignalDirection,
              confluenceScore: score.score,
              status: SignalStatus.PENDING,
            },
          });

          await this.redis.set(
            `trading:signal:${createdSignal.id}`,
            JSON.stringify(createdSignal),
            'EX',
            cacheTtl,
          );

          this.tradingGateway.emitToUser(userId, 'signal.new', createdSignal);
        }
      }
    } catch (error) {
      this.logger.error(`Signal scan failed for user ${userId}: ${(error as Error).message}`);
      this.tradingGateway.emitToUser(userId, 'brain.error', {
        message: (error as Error).message,
      });
    } finally {
      await this.redis.del(lockKey);
    }
  }

  /**
   * Graceful worker shutdown: allow active cycle to finish, then close redis.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit();
  }

  private async fetchLatestCandles(market: string, timeframe: string): Promise<OhlcvCandle[]> {
    const provider = this.configService.get<string>('MARKET_DATA_PROVIDER', '');
    const apiKey = this.configService.get<string>('MARKET_DATA_API_KEY', '');
    const baseUrl = this.configService.get<string>('MARKET_DATA_BASE_URL', '');

    // TODO: Replace with confirmed OHLCV data provider.
    if (!provider || !baseUrl) return [];

    const url = `${baseUrl}?market=${encodeURIComponent(market)}&timeframe=${encodeURIComponent(timeframe)}`;
    const response = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
    });
    if (!response.ok) return [];

    const payload = (await response.json()) as { candles?: OhlcvCandle[] };
    return payload.candles ?? [];
  }

  private buildMarketContext(market: string, timeframe: string, candles: OhlcvCandle[]): ScanMarketContext {
    const latest = candles[candles.length - 1];
    const avgVolume =
      candles.reduce((acc, c) => acc + c.volume, 0) / (candles.length || 1);
    return {
      market,
      timeframe,
      isAtSupport: false,
      isAtResistance: false,
      isTrendAligned: false,
      isMarketStructureAligned: false,
      isVolumeSpike: latest ? latest.volume > avgVolume * 1.5 : false,
      isSessionTiming: false,
      isLiquiditySweep: false,
    };
  }
}

