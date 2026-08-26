// Load .env before anything below reads process.env.DATABASE_URL. This
// module must be self-sufficient regardless of import order in whatever
// entry point requires it (ES import statements are hoisted and evaluated
// before an importer's own top-level `dotenv.config()` call would run).
import 'dotenv/config';
import { PrismaClient, Prisma } from '../generated/prisma';
import { PrismaPg } from '@prisma/adapter-pg';
import { logger } from '../logging';

const { Decimal } = Prisma;

// Allows callers (e.g. trading-engine's close-trade transaction) to pass an
// interactive transaction client so writes commit atomically, while
// defaulting to the module-level client for existing non-transactional callers.
export type DbClient = PrismaClient | Prisma.TransactionClient;

// Initialize Prisma Client (Prisma 7 style).
// As of Prisma 7, the "prisma-client-js" engine type requires an explicit
// driver adapter (the Rust query engine binary is no longer embedded).
// The datasource URL itself is resolved via prisma.config.ts for the CLI
// (migrate/generate), but the adapter needs its own connection string at
// runtime since the PrismaClient constructor no longer reads it implicitly.
if (!process.env.DATABASE_URL) {
  const hint =
    process.env.RENDER === 'true' || process.env.RENDER_SERVICE_ID
      ? ' On Render: Dashboard → your Web Service → Environment → Add DATABASE_URL ' +
        '(Internal Database URL from your Render Postgres, or link the DB in Blueprint).'
      : ' Set DATABASE_URL in backend/.env for local, or in your host env for cloud.';
  throw new Error(
    'DATABASE_URL environment variable is required to initialize the database adapter.' + hint
  );
}

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });

const prisma = new PrismaClient({
  adapter,
  log: process.env.NODE_ENV === 'production' ? ['warn', 'error'] : ['query', 'info', 'warn', 'error'],
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

// --- CANDLE INDICATORS ---

export async function saveCandleIndicators(data: {
  candleId: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
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
  trendStrength: number;
  trendDirection: string;
  momentumStrength: number;
  momentumDirection: string;
  atrRatio: number;
  volatilityLevel: string;
  bbBandwidth?: number;
  bbPosition?: number;
  liquiditySweep: string;
  liquidityLevel?: number;
  swingHigh?: number;
  swingLow?: number;
  swingStructure?: string;
  bullishOrderBlockPresent: boolean;
  bearishOrderBlockPresent: boolean;
  orderBlockZoneStart?: number;
  orderBlockZoneEnd?: number;
  bullishFvgPresent: boolean;
  bearishFvgPresent: boolean;
  fvgStart?: number;
  fvgEnd?: number;
  fvgFilledPercent?: number;
  nearestSupport?: number;
  nearestResistance?: number;
  distanceToSupport?: number;
  distanceToResistance?: number;
  marketSession: string;
  prevCandleBullish: boolean;
  prevCandleBearish: boolean;
  prevCandleSizeRatio?: number;
  gapUp: boolean;
  gapDown: boolean;
  threeCandlePattern?: string;
  normalizedClose?: number;
  normalizedHigh?: number;
  normalizedLow?: number;
  normalizedOpen?: number;
  normalizedVolume?: number;
}) {
  try {
    const dec = (n: number | undefined | null) =>
      n === undefined || n === null ? null : new Decimal(Number(n).toString());

    return await (prisma as any).candleIndicator.upsert({
      where: {
        candleId: data.candleId,
      },
      update: {
        open: new Decimal(Number(data.open).toString()),
        high: new Decimal(Number(data.high).toString()),
        low: new Decimal(Number(data.low).toString()),
        close: new Decimal(Number(data.close).toString()),
        volume: new Decimal(Number(data.volume).toString()),
        atr: new Decimal(Number(data.atr).toString()),
        rsi: new Decimal(Number(data.rsi).toString()),
        macd: dec(data.macd),
        macdSignal: dec(data.macdSignal),
        macdHistogram: dec(data.macdHistogram),
        ema20: new Decimal(Number(data.ema20).toString()),
        ema50: new Decimal(Number(data.ema50).toString()),
        ema100: dec(data.ema100),
        vwap: new Decimal(Number(data.vwap).toString()),
        adx: new Decimal(Number(data.adx).toString()),
        bbUpper: new Decimal(Number(data.bbUpper).toString()),
        bbMiddle: new Decimal(Number(data.bbMiddle).toString()),
        bbLower: new Decimal(Number(data.bbLower).toString()),
        trendStrength: new Decimal(Number(data.trendStrength).toString()),
        trendDirection: data.trendDirection,
        momentumStrength: new Decimal(Number(data.momentumStrength).toString()),
        momentumDirection: data.momentumDirection,
        atrRatio: new Decimal(Number(data.atrRatio).toString()),
        volatilityLevel: data.volatilityLevel,
        bbBandwidth: dec(data.bbBandwidth),
        bbPosition: dec(data.bbPosition),
        liquiditySweep: data.liquiditySweep,
        liquidityLevel: dec(data.liquidityLevel),
        swingHigh: dec(data.swingHigh),
        swingLow: dec(data.swingLow),
        swingStructure: data.swingStructure || null,
        bullishOrderBlockPresent: data.bullishOrderBlockPresent,
        bearishOrderBlockPresent: data.bearishOrderBlockPresent,
        orderBlockZoneStart: dec(data.orderBlockZoneStart),
        orderBlockZoneEnd: dec(data.orderBlockZoneEnd),
        bullishFvgPresent: data.bullishFvgPresent,
        bearishFvgPresent: data.bearishFvgPresent,
        fvgStart: dec(data.fvgStart),
        fvgEnd: dec(data.fvgEnd),
        fvgFilledPercent: dec(data.fvgFilledPercent),
        nearestSupport: dec(data.nearestSupport),
        nearestResistance: dec(data.nearestResistance),
        distanceToSupport: dec(data.distanceToSupport),
        distanceToResistance: dec(data.distanceToResistance),
        marketSession: data.marketSession,
        prevCandleBullish: data.prevCandleBullish,
        prevCandleBearish: data.prevCandleBearish,
        prevCandleSizeRatio: dec(data.prevCandleSizeRatio),
        gapUp: data.gapUp,
        gapDown: data.gapDown,
        threeCandlePattern: data.threeCandlePattern || null,
        normalizedClose: dec(data.normalizedClose),
        normalizedHigh: dec(data.normalizedHigh),
        normalizedLow: dec(data.normalizedLow),
        normalizedOpen: dec(data.normalizedOpen),
        normalizedVolume: dec(data.normalizedVolume),
      },
      create: {
        candleId: data.candleId,
        open: new Decimal(Number(data.open).toString()),
        high: new Decimal(Number(data.high).toString()),
        low: new Decimal(Number(data.low).toString()),
        close: new Decimal(Number(data.close).toString()),
        volume: new Decimal(Number(data.volume).toString()),
        atr: new Decimal(Number(data.atr).toString()),
        rsi: new Decimal(Number(data.rsi).toString()),
        macd: dec(data.macd),
        macdSignal: dec(data.macdSignal),
        macdHistogram: dec(data.macdHistogram),
        ema20: new Decimal(Number(data.ema20).toString()),
        ema50: new Decimal(Number(data.ema50).toString()),
        ema100: dec(data.ema100),
        vwap: new Decimal(Number(data.vwap).toString()),
        adx: new Decimal(Number(data.adx).toString()),
        bbUpper: new Decimal(Number(data.bbUpper).toString()),
        bbMiddle: new Decimal(Number(data.bbMiddle).toString()),
        bbLower: new Decimal(Number(data.bbLower).toString()),
        trendStrength: new Decimal(Number(data.trendStrength).toString()),
        trendDirection: data.trendDirection,
        momentumStrength: new Decimal(Number(data.momentumStrength).toString()),
        momentumDirection: data.momentumDirection,
        atrRatio: new Decimal(Number(data.atrRatio).toString()),
        volatilityLevel: data.volatilityLevel,
        bbBandwidth: dec(data.bbBandwidth),
        bbPosition: dec(data.bbPosition),
        liquiditySweep: data.liquiditySweep,
        liquidityLevel: dec(data.liquidityLevel),
        swingHigh: dec(data.swingHigh),
        swingLow: dec(data.swingLow),
        swingStructure: data.swingStructure || null,
        bullishOrderBlockPresent: data.bullishOrderBlockPresent,
        bearishOrderBlockPresent: data.bearishOrderBlockPresent,
        orderBlockZoneStart: dec(data.orderBlockZoneStart),
        orderBlockZoneEnd: dec(data.orderBlockZoneEnd),
        bullishFvgPresent: data.bullishFvgPresent,
        bearishFvgPresent: data.bearishFvgPresent,
        fvgStart: dec(data.fvgStart),
        fvgEnd: dec(data.fvgEnd),
        fvgFilledPercent: dec(data.fvgFilledPercent),
        nearestSupport: dec(data.nearestSupport),
        nearestResistance: dec(data.nearestResistance),
        distanceToSupport: dec(data.distanceToSupport),
        distanceToResistance: dec(data.distanceToResistance),
        marketSession: data.marketSession,
        prevCandleBullish: data.prevCandleBullish,
        prevCandleBearish: data.prevCandleBearish,
        prevCandleSizeRatio: dec(data.prevCandleSizeRatio),
        gapUp: data.gapUp,
        gapDown: data.gapDown,
        threeCandlePattern: data.threeCandlePattern || null,
        normalizedClose: dec(data.normalizedClose),
        normalizedHigh: dec(data.normalizedHigh),
        normalizedLow: dec(data.normalizedLow),
        normalizedOpen: dec(data.normalizedOpen),
        normalizedVolume: dec(data.normalizedVolume),
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
  // Ensemble Phase 1 (additive, all optional)
  fnnOutput?: any;
  cnnOutput?: any;
  lstmOutput?: any;
  ensembleOutput?: any;
  marketRegime?: string;
  regimeConfidence?: number;
  executionQuality?: number;
  slippagePips?: number;
  entryLatencyMs?: number;
  detectedPattern?: string;
  patternConfidence?: number;
  psychologyScore?: number;
  misclassificationReason?: string;
  confidenceError?: number;
  predictionError?: number;
}, db: DbClient = prisma) {
  try {
    const entryTs = data.entryTimestamp instanceof Date ? data.entryTimestamp : new Date(data.entryTimestamp);
    const closeTs = data.closeTimestamp ? (data.closeTimestamp instanceof Date ? data.closeTimestamp : new Date(data.closeTimestamp)) : null;
    const dec = (n: number | undefined) => (n === undefined || n === null ? null : new Decimal(Number(n).toString()));

    return await db.tradeDNA.upsert({
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
        fnnOutput: data.fnnOutput,
        cnnOutput: data.cnnOutput,
        lstmOutput: data.lstmOutput,
        ensembleOutput: data.ensembleOutput,
        marketRegime: data.marketRegime,
        regimeConfidence: dec(data.regimeConfidence),
        executionQuality: dec(data.executionQuality),
        slippagePips: dec(data.slippagePips),
        entryLatencyMs: dec(data.entryLatencyMs),
        detectedPattern: data.detectedPattern,
        patternConfidence: dec(data.patternConfidence),
        psychologyScore: dec(data.psychologyScore),
        misclassificationReason: data.misclassificationReason,
        confidenceError: dec(data.confidenceError),
        predictionError: dec(data.predictionError),
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
        fnnOutput: data.fnnOutput,
        cnnOutput: data.cnnOutput,
        lstmOutput: data.lstmOutput,
        ensembleOutput: data.ensembleOutput,
        marketRegime: data.marketRegime,
        regimeConfidence: dec(data.regimeConfidence),
        executionQuality: dec(data.executionQuality),
        slippagePips: dec(data.slippagePips),
        entryLatencyMs: dec(data.entryLatencyMs),
        detectedPattern: data.detectedPattern,
        patternConfidence: dec(data.patternConfidence),
        psychologyScore: dec(data.psychologyScore),
        misclassificationReason: data.misclassificationReason,
        confidenceError: dec(data.confidenceError),
        predictionError: dec(data.predictionError),
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

// --- POST-TRADE ANALYSIS ---

export async function savePostTradeAnalysis(data: {
  ticket: string;
  symbol: string;
  direction: string;
  outcome: string;
  profitPips: number;
  profitDollars: number;
  modelVersion?: string;
  aiConfidence?: number;
  analysis: any;
  lessons: string[];
  labeledSampleId?: string;
}, db: DbClient = prisma) {
  try {
    const aiConfDecimal = data.aiConfidence !== undefined ? new Decimal(data.aiConfidence.toString()) : null;

    return await db.postTradeAnalysis.upsert({
      where: {
        ticket: data.ticket,
      },
      update: {
        outcome: data.outcome,
        profitPips: new Decimal(data.profitPips.toString()),
        profitDollars: new Decimal(data.profitDollars.toString()),
        aiConfidence: aiConfDecimal,
        analysis: data.analysis,
        lessons: data.lessons,
        labeledSampleId: data.labeledSampleId || null,
      },
      create: {
        ticket: data.ticket,
        symbol: data.symbol,
        direction: data.direction,
        outcome: data.outcome,
        profitPips: new Decimal(data.profitPips.toString()),
        profitDollars: new Decimal(data.profitDollars.toString()),
        modelVersion: data.modelVersion || null,
        aiConfidence: aiConfDecimal,
        analysis: data.analysis,
        lessons: data.lessons,
        labeledSampleId: data.labeledSampleId || null,
      },
    });
  } catch (error) {
    logger.error('Failed to save PostTradeAnalysis', error);
    return null;
  }
}

// --- ENSEMBLE PREDICTION (Phase 1, additive, nullable) ---

export async function saveEnsemblePrediction(data: {
  ticket?: string;
  signalId?: string;
  symbol: string;
  proposedDirection: string;
  finalScore: number;
  decision: string;
  fnnVersion?: string;
  cnnVersion?: string;
  lstmVersion?: string;
  fnnOutput?: any;
  cnnOutput?: any;
  lstmOutput?: any;
  ruleConfidence: number;
  explainability: any;
  regime: string;
  regimeConfidence: number;
  weightsUsed: any;
  perModelScores: any;
  reasons: string[];
  hardGateEnabled?: boolean;
  predictionLogId?: string;
  tradeDnaId?: string;
}, db: DbClient = prisma) {
  try {
    // NOTE: `ensemblePrediction` table is added to Prisma schema in Phase 1.
    // Until `prisma generate` is re-run locally, `DbClient` types don't know
    // about the new table. Cast through `any` so compilation passes before
    // the developer runs the generate step; runtime path is identical.
    const client: any = db;
    return await client.ensemblePrediction.create({
      data: {
        ticket: data.ticket || null,
        signalId: data.signalId || null,
        symbol: data.symbol,
        proposedDirection: data.proposedDirection,
        finalScore: new Decimal(Number(data.finalScore).toString()),
        decision: data.decision,
        fnnVersion: data.fnnVersion || null,
        cnnVersion: data.cnnVersion || null,
        lstmVersion: data.lstmVersion || null,
        fnnOutput: data.fnnOutput || null,
        cnnOutput: data.cnnOutput || null,
        lstmOutput: data.lstmOutput || null,
        ruleConfidence: new Decimal(Number(data.ruleConfidence).toString()),
        explainability: data.explainability,
        regime: data.regime,
        regimeConfidence: new Decimal(Number(data.regimeConfidence).toString()),
        weightsUsed: data.weightsUsed,
        perModelScores: data.perModelScores,
        reasons: data.reasons,
        hardGateEnabled: !!data.hardGateEnabled,
        predictionLogId: data.predictionLogId || null,
        tradeDnaId: data.tradeDnaId || null,
      },
    });
  } catch (error) {
    logger.error('Failed to save EnsemblePrediction', error);
    return null;
  }
}

export { prisma };
