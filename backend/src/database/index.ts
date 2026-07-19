import { PrismaClient, Decimal } from '../generated/prisma';
import { logger } from '../logging';

// Initialize Prisma Client (Prisma 7 style)
const prisma = new PrismaClient({
  datasourceUrl: process.env.DATABASE_URL,
  log: ['query', 'info', 'warn', 'error'],
});

export async function initDb() {
  try {
    await prisma.$connect();
    logger.success('PostgreSQL database connected successfully');
    return prisma;
  } catch (error) {
    logger.error('Failed to connect to database', error);
    throw error;
  }
}

// --- TICKS ---

export async function saveTick(data: {
  symbol: string;
  bid: number;
  ask: number;
  spread: number;
  volume: number;
}) {
  try {
    return await prisma.tick.create({
      data: {
        symbol: data.symbol,
        bid: new Decimal(data.bid.toString()),
        ask: new Decimal(data.ask.toString()),
        spread: new Decimal(data.spread.toString()),
        volume: new Decimal(data.volume.toString()),
      },
    });
  } catch (error) {
    logger.error('Failed to save tick', error);
    return null;
  }
}

// --- CANDLES ---

export async function saveCandle(data: {
  symbol: string;
  timeframe: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: Date | number;
}) {
  try {
    const ts = data.timestamp instanceof Date ? data.timestamp : new Date(data.timestamp);
    return await prisma.candle.upsert({
      where: {
        symbol_timeframe_timestamp: {
          symbol: data.symbol,
          timeframe: data.timeframe,
          timestamp: ts,
        },
      },
      update: {
        open: new Decimal(data.open.toString()),
        high: new Decimal(data.high.toString()),
        low: new Decimal(data.low.toString()),
        close: new Decimal(data.close.toString()),
        volume: new Decimal(data.volume.toString()),
      },
      create: {
        symbol: data.symbol,
        timeframe: data.timeframe,
        open: new Decimal(data.open.toString()),
        high: new Decimal(data.high.toString()),
        low: new Decimal(data.low.toString()),
        close: new Decimal(data.close.toString()),
        volume: new Decimal(data.volume.toString()),
        timestamp: ts,
      },
    });
  } catch (error) {
    logger.error('Failed to save candle', error);
    return null;
  }
}

export async function saveCandleIndicators(data: {
  candleId: string;
  atr: number;
  rsi: number;
  macd?: number;
  macdSignal?: number;
  macdHistogram?: number;
  ema20: number;
  ema50: number;
  ema100?: number;
  vwap: number;
  adx: number;
  bbUpper: number;
  bbMiddle: number;
  bbLower: number;
}) {
  try {
    return await prisma.candleIndicator.upsert({
      where: {
        candleId: data.candleId,
      },
      update: {
        atr: new Decimal(data.atr.toString()),
        rsi: new Decimal(data.rsi.toString()),
        macd: data.macd ? new Decimal(data.macd.toString()) : null,
        macdSignal: data.macdSignal ? new Decimal(data.macdSignal.toString()) : null,
        macdHistogram: data.macdHistogram ? new Decimal(data.macdHistogram.toString()) : null,
        ema20: new Decimal(data.ema20.toString()),
        ema50: new Decimal(data.ema50.toString()),
        ema100: data.ema100 ? new Decimal(data.ema100.toString()) : null,
        vwap: new Decimal(data.vwap.toString()),
        adx: new Decimal(data.adx.toString()),
        bbUpper: new Decimal(data.bbUpper.toString()),
        bbMiddle: new Decimal(data.bbMiddle.toString()),
        bbLower: new Decimal(data.bbLower.toString()),
      },
      create: {
        candleId: data.candleId,
        atr: new Decimal(data.atr.toString()),
        rsi: new Decimal(data.rsi.toString()),
        macd: data.macd ? new Decimal(data.macd.toString()) : null,
        macdSignal: data.macdSignal ? new Decimal(data.macdSignal.toString()) : null,
        macdHistogram: data.macdHistogram ? new Decimal(data.macdHistogram.toString()) : null,
        ema20: new Decimal(data.ema20.toString()),
        ema50: new Decimal(data.ema50.toString()),
        ema100: data.ema100 ? new Decimal(data.ema100.toString()) : null,
        vwap: new Decimal(data.vwap.toString()),
        adx: new Decimal(data.adx.toString()),
        bbUpper: new Decimal(data.bbUpper.toString()),
        bbMiddle: new Decimal(data.bbMiddle.toString()),
        bbLower: new Decimal(data.bbLower.toString()),
      },
    });
  } catch (error) {
    logger.error('Failed to save candle indicators', error);
    return null;
  }
}

// --- ACCOUNT SNAPSHOTS ---

export async function saveAccountSnapshot(data: {
  balance: number;
  equity: number;
  margin: number;
  marginLevel?: number;
  floatingPL: number;
  openPositions: number;
  currency: string;
}) {
  try {
    return await prisma.accountSnapshot.create({
      data: {
        balance: new Decimal(data.balance.toString()),
        equity: new Decimal(data.equity.toString()),
        margin: new Decimal(data.margin.toString()),
        marginLevel: data.marginLevel ? new Decimal(data.marginLevel.toString()) : null,
        floatingPL: new Decimal(data.floatingPL.toString()),
        openPositions: data.openPositions,
        currency: data.currency,
      },
    });
  } catch (error) {
    logger.error('Failed to save account snapshot', error);
    return null;
  }
}

// --- POSITIONS ---

export async function savePosition(data: {
  ticket: string;
  symbol: string;
  direction: string;
  openPrice: number;
  currentPrice: number;
  sl?: number;
  tp?: number;
  lotSize: number;
  profit: number;
  openTimestamp: Date | number;
  isOpen: boolean;
  tradeDnaId?: string;
}) {
  try {
    const openTs = data.openTimestamp instanceof Date ? data.openTimestamp : new Date(data.openTimestamp);

    return await prisma.position.upsert({
      where: {
        ticket: data.ticket,
      },
      update: {
        currentPrice: new Decimal(data.currentPrice.toString()),
        sl: data.sl ? new Decimal(data.sl.toString()) : null,
        tp: data.tp ? new Decimal(data.tp.toString()) : null,
        profit: new Decimal(data.profit.toString()),
        isOpen: data.isOpen,
        closeTimestamp: data.isOpen ? null : new Date(),
        updatedAt: new Date(),
      },
      create: {
        ticket: data.ticket,
        symbol: data.symbol,
        direction: data.direction,
        openPrice: new Decimal(data.openPrice.toString()),
        currentPrice: new Decimal(data.currentPrice.toString()),
        sl: data.sl ? new Decimal(data.sl.toString()) : null,
        tp: data.tp ? new Decimal(data.tp.toString()) : null,
        lotSize: new Decimal(data.lotSize.toString()),
        profit: new Decimal(data.profit.toString()),
        openTimestamp: openTs,
        isOpen: data.isOpen,
        tradeDnaId: data.tradeDnaId,
      },
    });
  } catch (error) {
    logger.error('Failed to save position', error);
    return null;
  }
}

// --- TRADE DNA ---

export async function saveTradeDna(data: {
  ticket: string;
  symbol: string;
  direction: string;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  lotSize: number;
  riskPercent: number;
  outcome: string;
  profitPips: number;
  profitPercent: number;
  profitDollars: number;
  aiConfidence: number;
  modelVersion: string;
  mistakes: string[];
  lessons: string[];
  notes?: string;
  entryFeatures: any;
  closeFeatures?: any;
  screenshots?: any;
  entryTimestamp: Date | number;
  closeTimestamp?: Date | number;
}) {
  try {
    const entryTs = data.entryTimestamp instanceof Date ? data.entryTimestamp : new Date(data.entryTimestamp);
    const closeTs = data.closeTimestamp ? (data.closeTimestamp instanceof Date ? data.closeTimestamp : new Date(data.closeTimestamp)) : null;

    return await prisma.tradeDNA.upsert({
      where: {
        ticket: data.ticket,
      },
      update: {
        outcome: data.outcome,
        profitPips: new Decimal(data.profitPips.toString()),
        profitPercent: new Decimal(data.profitPercent.toString()),
        profitDollars: new Decimal(data.profitDollars.toString()),
        closeFeatures: data.closeFeatures || null,
        closeTimestamp: closeTs,
        updatedAt: new Date(),
      },
      create: {
        ticket: data.ticket,
        symbol: data.symbol,
        direction: data.direction,
        entryPrice: new Decimal(data.entryPrice.toString()),
        stopLoss: new Decimal(data.stopLoss.toString()),
        takeProfit: new Decimal(data.takeProfit.toString()),
        lotSize: new Decimal(data.lotSize.toString()),
        riskPercent: new Decimal(data.riskPercent.toString()),
        outcome: data.outcome,
        profitPips: new Decimal(data.profitPips.toString()),
        profitPercent: new Decimal(data.profitPercent.toString()),
        profitDollars: new Decimal(data.profitDollars.toString()),
        aiConfidence: new Decimal(data.aiConfidence.toString()),
        modelVersion: data.modelVersion,
        mistakes: data.mistakes,
        lessons: data.lessons,
        notes: data.notes || null,
        entryFeatures: data.entryFeatures,
        closeFeatures: data.closeFeatures || null,
        screenshots: data.screenshots || null,
        entryTimestamp: entryTs,
        closeTimestamp: closeTs,
      },
    });
  } catch (error) {
    logger.error('Failed to save TradeDNA', error);
    return null;
  }
}

// --- QUERIES ---

export async function getCandles(symbol: string, timeframe: string, limit: number = 1000) {
  try {
    return await prisma.candle.findMany({
      where: {
        symbol,
        timeframe,
      },
      orderBy: {
        timestamp: 'desc',
      },
      take: limit,
      include: {
        indicators: true,
      },
    });
  } catch (error) {
    logger.error('Failed to fetch candles', error);
    return [];
  }
}

export { prisma };
