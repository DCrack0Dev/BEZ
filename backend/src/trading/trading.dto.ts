import { IsEnum } from 'class-validator';
import { TradingMode } from './trading.types';

export class UpdateTradingModeDto {
  @IsEnum(TradingMode)
  mode!: TradingMode;
}

export class TradingModeResponseDto {
  tradingMode!: TradingMode;
  isActive!: boolean;
  hasRepeatableJob!: boolean;
}

