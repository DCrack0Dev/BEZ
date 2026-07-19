import { v4 as uuidv4 } from 'uuid';
import { Server } from 'socket.io';
import {
  Candle,
  MT5Payload,
  PositionState,
  FeatureSet,
  TradeDNA,
  Lesson,
} from '../types';
import { logger, tradingLogger } from '../logging';
import { CONFIG } from '../config/tradingConfig';
import { FeatureEngineeringEngine } from '../feature-engineering/featureEngine';
import { processTrailingStop } from '../trade-execution/trailingStopManager';
import { validateSignal, calculateATR, calculateSwingHighs, calculateSwingLows, calculateEMA } from './signalValidator';
import { TradeDnaEngine } from '../analytics/tradeDna';
import { ExperienceEngine } from '../analytics/experienceEngine';
import {
  initDb,
  prisma,
  saveTick,
  saveCandle,
  saveAccountSnapshot,
  savePosition,
  saveTradeDna,
} from '../database';

export interface AccountState {
  balance: number;
  equity: number;
  positions: any[];
  ea_connected: boolean;
  symbol: string;
  price: number;
  spread: number;
  chart: Record<string, Candle[]>;
  lastUpdate: number;
  pipSize: number;
  pointSize: number;
  pipValue: number;
  minLot: number;
  maxLot: number;
  minLotStep: number;
  ema20: number;
  ema20Prev: number;
  ema50: number;
  atr14: number;
  candles: Candle[];
  autoTradingEnabled: boolean;
  lastFeatures?: FeatureSet;
}

export class TradingEngine {
  private accountState: AccountState = {
    balance: 0,
    equity: 0,
    positions: [],
    ea_connected: false,
    symbol: '',
    price: 0,
    spread: 0,
    chart: {},
    lastUpdate: 0,
    pipSize: 0.01,
    pointSize: 0.001,
    pipValue: 1,
    minLot: 0.01,
    maxLot: 100,
    minLotStep: 0.01,
    ema20: 0,
    ema20Prev: 0,
    ema50: 0,
    atr14: 0,
    candles: [],
    autoTradingEnabled: false,
  };

  private pendingCommands: any[] = [];
  private closedTrades: any[] = [];
  private positionStates: Record<string, PositionState> = {};
  private openPositionTickets: Set<string> = new Set();
  private lastTradeTime = 0;
  private cooldowns: Record<'BUY' | 'SELL', number> = { BUY: 0, SELL: 0 };
  private lastSnapshotTime = 0;

  private featureEngine = new FeatureEngineeringEngine();
  private dnaEngine = new TradeDnaEngine();
  private experienceEngine = new ExperienceEngine();

  constructor(private io: Server) {}

  async init() {
    await initDb();
    logger.success('Trading Engine initialized with PostgreSQL');
  }

  // Getters
  getAccountState(): AccountState {
    return { ...this.accountState };
  }
  getPendingCommands(): any[] {
    return [...this.pendingCommands];
  }
  getClosedTrades(): any[] {
    return [...this.closedTrades];
  }
  getDna(): TradeDNA[] {
    return this.dnaEngine.getAllDna();
  }
  getLessons(): Lesson[] {
    return this.experienceEngine.getLessons();
  }

  clearPendingCommands(): any[] {
    const cmds = [...this.pendingCommands];
    this.pendingCommands = [];
    return cmds;
  }
  addCommand(cmd: any): void {
    this.pendingCommands.push(cmd);
  }

  // --- MARKET DATA PIPELINE ---
  private async persistMarketData(payload: MT5Payload, features: FeatureSet) {
    try {
      // 1. Save Tick Data
      if (payload.price && payload.spread !== undefined) {
        await saveTick({
          symbol: payload.symbol,
          bid: payload.price - (payload.spread / 2),
          ask: payload.price + (payload.spread / 2),
          spread: payload.spread,
          volume: 0, // Default to 0 if not provided
        });
      }

      // 2. Save Candle
      if (payload.candles && payload.candles.length > 0) {
        const lastCandle = payload.candles[payload.candles.length - 1];
        const savedCandle = await saveCandle({
          symbol: payload.symbol,
          timeframe: 'M5',
          open: lastCandle.open,
          high: lastCandle.high,
          low: lastCandle.low,
          close: lastCandle.close,
          volume: lastCandle.volume || 0,
          timestamp: lastCandle.timestamp,
        });
      }

      // 3. Save Account Snapshot (once per 5 seconds)
      const now = Date.now();
      if (now - this.lastSnapshotTime > 5000) {
        this.lastSnapshotTime = now;
        await saveAccountSnapshot({
          balance: payload.balance,
          equity: payload.equity,
          margin: 0, // Default if not available
          floatingPL: payload.positions?.reduce((sum, p) => sum + (p.profit || 0), 0) || 0,
          openPositions: payload.positions?.length || 0,
          currency: 'USD',
        });
      }

      // 4. Save Positions
      for (const pos of this.accountState.positions) {
        const ticket = String(pos.ticket);
        const existingDna = this.dnaEngine.getDnaByTicket(ticket);
        await savePosition({
          ticket,
          symbol: pos.symbol || payload.symbol,
          direction: (pos.type === 'BUY' || pos.type === 0) ? 'BUY' : 'SELL',
          openPrice: pos.openPrice || pos.price || this.accountState.price,
          currentPrice: this.accountState.price,
          sl: pos.sl || 0,
          tp: pos.tp || 0,
          lotSize: pos.volume || pos.lots || 0.01,
          profit: pos.profit || 0,
          openTimestamp: pos.time || new Date().getTime(),
          isOpen: true,
          tradeDnaId: existingDna ? existingDna.id : undefined,
        });
      }
    } catch (error) {
      logger.error('Failed to persist market data', error);
    }
  }

  async processMT5Update(payload: MT5Payload): Promise<void> {
    tradingLogger.info('Processing MT5 update', payload.symbol);

    // Extract candles
    let candles: Candle[] = payload.candles || [];
    if (payload.chart && typeof payload.chart === 'object' && !Array.isArray(payload.chart)) {
      candles = payload.chart['M5'] || candles;
    }
    const sortedCandles = [...candles].sort((a, b) => (b.x || b.timestamp) - (a.x || a.timestamp));
    const candlesReversed = [...sortedCandles].reverse();

    // Calculate indicators
    const ema20 = payload.ema20 || calculateEMA(candlesReversed, 20);
    const ema50 = calculateEMA(candlesReversed, 50);
    const atr14 = payload.atr14 || calculateATR(candlesReversed, 14);

    // Generate Features
    const features = this.featureEngine.generateFeatures(
      payload.symbol,
      candlesReversed,
      ema20,
      ema50,
      atr14,
      payload.spread || 0,
      payload.pipSize || 0.01
    );

    // Update Account State
    this.accountState = {
      ...this.accountState,
      ...payload,
      positions: payload.positions || payload.openPositions || [],
      chart: {
        'M5': sortedCandles,
        ...(payload.chart && typeof payload.chart === 'object' ? payload.chart : {}),
      },
      ea_connected: true,
      lastUpdate: Date.now(),
      pipSize: payload.pipSize || 0.01,
      pointSize: payload.pointSize || 0.001,
      pipValue: payload.pipValue || 1,
      minLot: payload.minLot || 0.01,
      maxLot: payload.maxLot || 100,
      minLotStep: payload.minLotStep || 0.01,
      ema20,
      ema20Prev: payload.ema20Prev || ema20,
      ema50,
      atr14,
      candles: sortedCandles,
      lastFeatures: features,
    };

    // Persist to PostgreSQL
    await this.persistMarketData(payload, features);

    // Handle Closed Trades
    const currentTickets = new Set((payload.positions || payload.openPositions || []).map(p => String(p.ticket)));
    for (const ticket of this.openPositionTickets) {
      if (!currentTickets.has(ticket)) {
        this.openPositionTickets.delete(ticket);
        const closedTrade = (payload.closedTrades || []).find(t => String(t.ticket) === ticket);
        const dna = this.dnaEngine.getDnaByTicket(ticket);
        if (dna) {
          const lessons = this.experienceEngine.analyzeTrade(dna);
          const finalizedDna = this.dnaEngine.finalizeTradeDNA(
            ticket,
            closedTrade?.closePrice || this.accountState.price,
            features,
            closedTrade?.profit || 0,
            0,
            0,
            lessons.map(l => l.title),
            lessons.map(l => l.description)
          );
          if (finalizedDna) {
            await saveTradeDna(finalizedDna as any);
          }
        }
        // Update closed position in DB
        await prisma.position.updateMany({
          where: { ticket: ticket },
          data: { isOpen: false, closeTimestamp: new Date() }
        });
      }
    }

    // Initialize DNA for new positions
    for (const pos of this.accountState.positions) {
      const ticket = String(pos.ticket);
      if (!this.openPositionTickets.has(ticket)) {
        this.openPositionTickets.add(ticket);
        const dna = this.dnaEngine.initializeTradeDNA(
          ticket,
          this.accountState.symbol,
          (pos.type === 'BUY' || pos.type === 0) ? 'BUY' : 'SELL',
          pos.openPrice || pos.price || this.accountState.price,
          pos.sl || 0,
          pos.tp || 0,
          pos.volume || pos.lots || 0.01,
          1.0,
          features
        );
        await saveTradeDna(dna as any);
      }
    }

    // Trailing Stop
    for (const pos of this.accountState.positions) {
      const ticket = String(pos.ticket);
      if (!this.positionStates[ticket]) {
        this.positionStates[ticket] = {
          ticket,
          signalId: uuidv4(),
          symbol: pos.symbol || this.accountState.symbol,
          direction: (pos.type === 'BUY' || pos.type === 0) ? 'BUY' : 'SELL',
          openPrice: pos.openPrice || pos.price || this.accountState.price,
          currentSL: pos.sl || 0,
          currentPrice: this.accountState.price,
          phase: 1,
          scaleInLevels: [],
          tpLevels: [],
          spread: this.accountState.spread,
          pipSize: this.accountState.pipSize,
          pointSize: this.accountState.pointSize,
        };
      } else {
        this.positionStates[ticket].currentPrice = this.accountState.price;
      }

      const tsUpdate = processTrailingStop(this.positionStates[ticket]);
      if (tsUpdate) {
        tradingLogger.info('TS update', ticket);
        this.positionStates[ticket].currentSL = tsUpdate.newSL;
        this.positionStates[ticket].phase = tsUpdate.phase;
        this.pendingCommands.push({
          action: 'UPDATE_SL',
          ticket,
          sl: tsUpdate.newSL,
        });
        this.io.emit('stopUpdate', {
          positionTicket: ticket,
          newStopLoss: tsUpdate.newSL,
          phase: tsUpdate.phase,
          isRiskFree: tsUpdate.phase >= 2,
          direction: this.positionStates[ticket].direction,
        });
      }
    }

    // Auto Trading
    if (this.accountState.autoTradingEnabled) {
      const swingHighs = payload.swingHighs || calculateSwingHighs(candlesReversed, 2);
      const swingLows = payload.swingLows || calculateSwingLows(candlesReversed, 2);
      const signalPayload: MT5Payload = {
        ...payload,
        symbol: this.accountState.symbol,
        timeframe: 'M5',
        candles: candlesReversed,
        spread: this.accountState.spread,
        balance: this.accountState.balance,
        equity: this.accountState.equity,
        pipSize: this.accountState.pipSize,
        pointSize: this.accountState.pointSize,
        pipValue: this.accountState.pipValue,
        minLot: this.accountState.minLot,
        maxLot: this.accountState.maxLot,
        minLotStep: this.accountState.minLotStep,
        swingHighs,
        swingLows,
        openPositionsCount: this.accountState.positions.length,
        ema20,
        ema20Prev: this.accountState.ema20Prev,
        atr14,
      };

      const signal = validateSignal(signalPayload);
      const now = Date.now();
      if (signal && now - this.lastTradeTime > 30000 && now > this.cooldowns[signal.direction]) {
        tradingLogger.success('New auto signal', signal.direction);
        this.pendingCommands.push({
          action: signal.direction,
          symbol: signal.symbol,
          lots: signal.lotSizes?.entry1 || 0.01,
          sl: signal.stopLoss,
          tp: signal.takeProfitLevels?.[0] || 0,
        });
        this.io.emit('tradeSignal', signal);
        this.lastTradeTime = now;
      }
    }

    this.io.emit('EA_HEARTBEAT', {
      ...this.accountState,
      lastSignalReason: `Trend: ${features.trendDirection} | Session: ${features.marketSession} | Vol: ${features.volatility}`
    });
  }
}
