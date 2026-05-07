import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { JwtModule } from '@nestjs/jwt';
import { TradingController } from './trading.controller';
import { TradingService } from './trading.service';
import { TradingJobService } from './trading-job.service';
import { TradingJobProcessor } from './trading-job.processor';
import { TradingGateway } from './trading.gateway';

@Module({
  imports: [
    ConfigModule,
    JwtModule.register({}),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: {
          url: configService.get<string>('REDIS_URL'),
        },
      }),
    }),
    BullModule.registerQueue({
      name: 'trading-signal-scan',
    }),
  ],
  controllers: [TradingController],
  providers: [
    TradingService,
    TradingJobService,
    TradingJobProcessor,
    TradingGateway,
  ],
  exports: [TradingService, TradingJobService],
})
export class TradingModule {}

