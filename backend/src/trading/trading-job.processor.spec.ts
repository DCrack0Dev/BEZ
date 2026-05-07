import { TradingJobProcessor } from './trading-job.processor';
import { SignalDirection, TradingMode } from './trading.types';

const redisMock = {
  set: jest.fn(),
  del: jest.fn(),
  quit: jest.fn(),
};

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => redisMock);
});

describe('TradingJobProcessor', () => {
  const prisma = {
    tradingConfig: { findUnique: jest.fn() },
    signal: { create: jest.fn() },
  };
  const configService = {
    get: jest.fn((key: string, defaultValue?: unknown) => {
      const values: Record<string, unknown> = {
        REDIS_URL: 'redis://localhost:6379',
        CONFLUENCE_THRESHOLD: 75,
        SIGNAL_CACHE_TTL_SECONDS: 60,
        MARKET_DATA_PROVIDER: '',
        MARKET_DATA_API_KEY: '',
        MARKET_DATA_BASE_URL: '',
      };
      return values[key] ?? defaultValue;
    }),
  };
  const candlestickService = { detectPatterns: jest.fn() };
  const confluenceService = { score: jest.fn() };
  const tradingGateway = { emitToUser: jest.fn() };

  let processor: TradingJobProcessor;

  beforeEach(() => {
    jest.clearAllMocks();
    processor = new TradingJobProcessor(
      prisma as never,
      configService as never,
      candlestickService as never,
      confluenceService as never,
      tradingGateway as never,
    );
  });

  it('exits safely when duplicate job lock cannot be acquired', async () => {
    redisMock.set.mockResolvedValueOnce(null);
    await processor.process({ data: { userId: 'u1' } } as never);
    expect(prisma.tradingConfig.findUnique).not.toHaveBeenCalled();
  });

  it('creates pending signal and emits websocket event when score passes threshold', async () => {
    redisMock.set.mockResolvedValueOnce('OK').mockResolvedValueOnce('OK');
    prisma.tradingConfig.findUnique.mockResolvedValue({
      userId: 'u2',
      tradingMode: TradingMode.BACKEND,
      isActive: true,
      markets: ['BTCUSD'],
      timeframe: 'H1',
    });
    const fakeCandles = [
      { timestamp: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 },
      { timestamp: 2, open: 1.5, high: 2.5, low: 1, close: 2, volume: 200 },
    ];
    // fetchLatestCandles is private and returns [] when provider/baseUrl empty.
    // Override for focused unit test.
    (processor as any).fetchLatestCandles = jest.fn().mockResolvedValue(fakeCandles);
    (processor as any).buildMarketContext = jest.fn().mockReturnValue({
      market: 'BTCUSD',
      timeframe: 'H1',
      isAtSupport: true,
      isAtResistance: false,
      isTrendAligned: true,
      isMarketStructureAligned: true,
      isVolumeSpike: true,
      isSessionTiming: true,
    });
    candlestickService.detectPatterns.mockReturnValue([
      {
        patternName: 'BULLISH_ENGULFING',
        signal: SignalDirection.BULLISH,
        confluenceScore: 0,
        factors: [],
        timeframe: 'H1',
        timestamp: 2,
      },
    ]);
    confluenceService.score.mockReturnValue({ score: 80, strength: 'HIGH_PROBABILITY', factors: [] });
    prisma.signal.create.mockResolvedValue({ id: 's1', userId: 'u2' });

    await processor.process({ data: { userId: 'u2' } } as never);

    expect(prisma.signal.create).toHaveBeenCalled();
    expect(redisMock.set).toHaveBeenCalledWith(
      'trading:signal:s1',
      expect.any(String),
      'EX',
      60,
    );
    expect(tradingGateway.emitToUser).toHaveBeenCalledWith('u2', 'signal.new', { id: 's1', userId: 'u2' });
  });
});

