import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { TradingGateway } from './trading.gateway';
import { TradingMode, UserSignalScanJobData } from './trading.types';

@Injectable()
export class TradingJobService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(TradingJobService.name);
  private readonly queue: Queue<UserSignalScanJobData>;
  private readonly redis: Redis;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly tradingGateway: TradingGateway,
  ) {
    const redisUrl = this.configService.get<string>('REDIS_URL');
    this.redis = new Redis(redisUrl ?? '');
    this.queue = new Queue<UserSignalScanJobData>('trading-signal-scan', {
      connection: this.redis,
    });
  }

  /**
   * Starts a per-user repeatable signal scan job.
   */
  async startUserJob(userId: string): Promise<void> {
    const intervalMs = this.configService.get<number>('SIGNAL_SCAN_INTERVAL_MS', 30000);
    const jobName = this.jobName(userId);
    const job = await this.queue.add(
      jobName,
      { userId },
      {
        jobId: jobName,
        removeOnComplete: 100,
        removeOnFail: 100,
        repeat: { every: intervalMs },
      },
    );

    const repeatJobKey = job.repeatJobKey ?? `${jobName}:${intervalMs}`;
    await this.redis.set(this.jobRedisKey(userId), repeatJobKey);

    await this.prisma.tradingConfig.upsert({
      where: { userId },
      create: {
        userId,
        tradingMode: TradingMode.BACKEND,
        isActive: true,
        markets: [],
        timeframe: 'H1',
      },
      update: {
        tradingMode: TradingMode.BACKEND,
        isActive: true,
      },
    });

    this.tradingGateway.emitToUser(userId, 'brain.started', {
      userId,
      status: 'active',
    });
  }

  /**
   * Stops and removes a per-user repeatable signal scan job.
   */
  async stopUserJob(userId: string): Promise<void> {
    const intervalMs = this.configService.get<number>('SIGNAL_SCAN_INTERVAL_MS', 30000);
    const repeatJobKey = await this.redis.get(this.jobRedisKey(userId));
    const jobName = this.jobName(userId);

    if (repeatJobKey) {
      await this.queue.removeRepeatableByKey(repeatJobKey);
      await this.redis.del(this.jobRedisKey(userId));
    } else {
      await this.queue.removeRepeatable(jobName, { every: intervalMs, jobId: jobName });
    }

    await this.prisma.tradingConfig.updateMany({
      where: { userId },
      data: { isActive: false },
    });

    this.tradingGateway.emitToUser(userId, 'brain.stopped', {
      userId,
      status: 'inactive',
    });
  }

  /**
   * Checks if a user has a tracked repeatable job key in Redis.
   */
  async hasUserJob(userId: string): Promise<boolean> {
    return Boolean(await this.redis.get(this.jobRedisKey(userId)));
  }

  /**
   * Re-registers active BACKEND users on application bootstrap.
   */
  async onApplicationBootstrap(): Promise<void> {
    const activeConfigs = await this.prisma.tradingConfig.findMany({
      where: { tradingMode: TradingMode.BACKEND, isActive: true },
      select: { userId: true },
    });

    for (const config of activeConfigs) {
      try {
        await this.startUserJob(config.userId);
      } catch (error) {
        this.logger.error(`Failed to restore job for user ${config.userId}: ${(error as Error).message}`);
      }
    }
  }

  /**
   * Graceful shutdown hook for queue and redis.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
    await this.redis.quit();
  }

  private jobName(userId: string): string {
    return `signal-scan-${userId}`;
  }

  private jobRedisKey(userId: string): string {
    return `trading:job:${userId}`;
  }
}

