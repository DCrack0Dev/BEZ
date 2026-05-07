import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TradingJobService } from './trading-job.service';
import { TradingModeResponseDto, UpdateTradingModeDto } from './trading.dto';
import { TradingMode } from './trading.types';

@Injectable()
export class TradingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tradingJobService: TradingJobService,
  ) {}

  /**
   * Updates trading mode and starts/stops backend job for the user.
   */
  async updateMode(userId: string, dto: UpdateTradingModeDto): Promise<TradingModeResponseDto> {
    const config = await this.prisma.tradingConfig.upsert({
      where: { userId },
      create: {
        userId,
        tradingMode: dto.mode,
        isActive: dto.mode === TradingMode.BACKEND,
        markets: [],
        timeframe: 'H1',
      },
      update: {
        tradingMode: dto.mode,
        isActive: dto.mode === TradingMode.BACKEND,
      },
    });

    if (dto.mode === TradingMode.BACKEND) {
      await this.tradingJobService.startUserJob(userId);
    } else {
      await this.tradingJobService.stopUserJob(userId);
    }

    const hasRepeatableJob = await this.tradingJobService.hasUserJob(userId);
    return {
      tradingMode: config.tradingMode as TradingMode,
      isActive: config.isActive,
      hasRepeatableJob,
    };
  }

  /**
   * Returns trading mode and job status for a user.
   */
  async getMode(userId: string): Promise<TradingModeResponseDto> {
    const config = await this.prisma.tradingConfig.findUnique({
      where: { userId },
    });
    const hasRepeatableJob = await this.tradingJobService.hasUserJob(userId);

    return {
      tradingMode: (config?.tradingMode as TradingMode) ?? TradingMode.LOCAL,
      isActive: config?.isActive ?? false,
      hasRepeatableJob,
    };
  }
}

