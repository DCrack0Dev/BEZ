import { Test, TestingModule } from '@nestjs/testing';
import { TradingController } from './trading.controller';
import { TradingService } from './trading.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { TradingGateway } from './trading.gateway';
import { TradingMode } from './trading.types';

describe('TradingController', () => {
  let controller: TradingController;
  const tradingService = {
    updateMode: jest.fn(),
    getMode: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TradingController],
      providers: [
        { provide: TradingService, useValue: tradingService },
        { provide: PrismaService, useValue: { signal: { findFirst: jest.fn(), update: jest.fn() } } },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: TradingGateway, useValue: { emitToUser: jest.fn() } },
      ],
    }).compile();

    controller = module.get<TradingController>(TradingController);
  });

  it('PATCH /trading/mode delegates mode update', async () => {
    const expected = { tradingMode: TradingMode.BACKEND, isActive: true, hasRepeatableJob: true };
    tradingService.updateMode.mockResolvedValue(expected);

    const result = await controller.updateMode(
      { user: { sub: 'user-1' } } as never,
      { mode: TradingMode.BACKEND },
    );

    expect(tradingService.updateMode).toHaveBeenCalledWith('user-1', { mode: TradingMode.BACKEND });
    expect(result).toEqual(expected);
  });

  it('GET /trading/mode returns status', async () => {
    const expected = { tradingMode: TradingMode.LOCAL, isActive: false, hasRepeatableJob: false };
    tradingService.getMode.mockResolvedValue(expected);

    const result = await controller.getMode({ user: { sub: 'user-2' } } as never);

    expect(tradingService.getMode).toHaveBeenCalledWith('user-2');
    expect(result).toEqual(expected);
  });
});

