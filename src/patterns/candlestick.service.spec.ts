import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CandlestickService } from './candlestick.service';
import { PatternSignal } from './candlestick.types';

describe('CandlestickService', () => {
  let service: CandlestickService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CandlestickService,
        {
          provide: ConfigService,
          useValue: { get: (key: string, defaultValue: any) => defaultValue },
        },
      ],
    }).compile();

    service = module.get<CandlestickService>(CandlestickService);
  });

  it('should detect a Hammer pattern', () => {
    const candles = [
      { timestamp: 1, open: 100, high: 105, low: 95, close: 101, volume: 100 },
      { timestamp: 2, open: 100, high: 105, low: 95, close: 101, volume: 100 },
      { timestamp: 3, open: 100, high: 100.2, low: 95, close: 99.5, volume: 100 }, // Hammer: small body, long lower wick
    ];
    const results = service.detectPatterns(candles, 'H1');
    const hammer = results.find((r) => r.patternName === 'HAMMER');
    expect(hammer).toBeDefined();
    expect(hammer?.signal).toBe(PatternSignal.BULLISH);
  });

  it('should detect Shooting Star pattern', () => {
    const candles = [
      { timestamp: 1, open: 100, high: 105, low: 95, close: 101, volume: 100 },
      { timestamp: 2, open: 100, high: 105, low: 95, close: 101, volume: 100 },
      { timestamp: 3, open: 100, high: 105, low: 99.8, close: 100.5, volume: 100 }, // Shooting Star: small body, long upper wick
    ];
    const results = service.detectPatterns(candles, 'H1');
    const star = results.find((r) => r.patternName === 'SHOOTING_STAR');
    expect(star).toBeDefined();
    expect(star?.signal).toBe(PatternSignal.BEARISH);
  });

  it('should detect Bullish Engulfing', () => {
    const candles = [
      { timestamp: 1, open: 100, high: 105, low: 95, close: 101, volume: 100 },
      { timestamp: 2, open: 102, high: 103, low: 99, close: 100, volume: 100 }, // Small Bearish
      { timestamp: 3, open: 99, high: 104, low: 98, close: 103, volume: 100 }, // Large Bullish engulfing
    ];
    const results = service.detectPatterns(candles, 'H1');
    const engulfing = results.find((r) => r.patternName === 'BULLISH_ENGULFING');
    expect(engulfing).toBeDefined();
    expect(engulfing?.signal).toBe(PatternSignal.BULLISH);
  });

  it('should detect Pin Bar', () => {
    const candles = [
      { timestamp: 1, open: 100, high: 105, low: 95, close: 101, volume: 100 },
      { timestamp: 2, open: 100, high: 105, low: 95, close: 101, volume: 100 },
      { timestamp: 3, open: 100, high: 100.5, low: 90, close: 99.5, volume: 100 }, // Long lower wick Pin Bar
    ];
    const results = service.detectPatterns(candles, 'H1');
    const pinbar = results.find((r) => r.patternName === 'PIN_BAR');
    expect(pinbar).toBeDefined();
    expect(pinbar?.signal).toBe(PatternSignal.BULLISH);
  });

  it('should detect Inside Bar', () => {
    const candles = [
      { timestamp: 1, open: 100, high: 105, low: 95, close: 101, volume: 100 },
      { timestamp: 2, open: 100, high: 110, low: 90, close: 105, volume: 100 }, // Large Mother Bar
      { timestamp: 3, open: 100, high: 105, low: 95, close: 102, volume: 100 }, // Inside Bar
    ];
    const results = service.detectPatterns(candles, 'H1');
    const inside = results.find((r) => r.patternName === 'INSIDE_BAR');
    expect(inside).toBeDefined();
  });
});
