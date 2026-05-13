import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CandlestickService } from './candlestick.service';
import { ConfluenceService } from './confluence.service';
import { CandlestickController } from './candlestick.controller';

@Module({
  imports: [ConfigModule],
  controllers: [CandlestickController],
  providers: [CandlestickService, ConfluenceService],
  exports: [CandlestickService, ConfluenceService],
})
export class CandlestickModule {}
