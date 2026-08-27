import { v4 as uuidv4 } from 'uuid';
import { Server } from 'socket.io';
import {
  Candle,
  MT5Payload,
  FeatureSet,
  TradeDNA,
  Lesson,
  PositionState,
  TradeSignal,
} from '../types';
import { logger, tradingLogger } from '../logging';
import { CONFIG } from '../config/tradingConfig';
import { FeatureEngineeringEngine } from '../feature-engineering/featureEngine';
import { FeatureStorage } from '../feature-engineering/featureStorage';
import { processTrailingStop } from '../trade-execution/trailingStopManager';
import { validateSignal, calculateATR, calculateSwingHighs, calculateSwingLows, calculateEMA } from './signalValidator';
import { evaluateSetupProgress, SetupProgress } from './setupProgress';
import { TradeDnaEngine } from '../analytics/tradeDna';
import { ExperienceEngine } from '../analytics/experienceEngine';
import { liveTradeObserver } from '../analytics/tradeObserver';
import {
  initDb,
  saveTick,
  saveCandle,
  saveCandleIndicators,
  saveAccountSnapshot,
  savePosition,
  saveTradeDna,
  savePostTradeAnalysis,
  saveEnsemblePrediction,
  getAdvancedJournalClosedTrades,
  prisma,
} from '../database';
import { ensembleDecisionEngine } from '../ensemble';
import { marketRegimeDetector } from '../regime-detector';
import type {
  EnsembleDecision,
  MarketRegimeClassification,
  RiskScore,
  SpreadStatus,
  Volatility,
  MarketSession,
} from '../types';
import { journalManager } from '../trade-journal';
import { continuousLearning, featureVector } from '../continuous-learning';
import { monitoring } from '../monitoring';
import { modelManager } from '../model-management';
import { confidenceEngine } from '../confidence-engine';
import { TradingPrediction } from '../ai/tradingModel';
import { gateConfig } from '../gate-config/gateConfig';
import { proposalEngine } from '../gate-config/proposalEngine';

export interface AccountState {
  balance: number;
  equity: number;
  positions: any[];
  ea_connected: boolean;
  symbol: string;
  price: number;
  spread: number;
  currency: string;
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
  aiTradingEnabled: boolean;
  /** When true, respect CONFIG.blockedSessions (Asia). When false, trade any time. */
  timezoneTradingEnabled: boolean;
  /** Max allowed spread in points (XAUUSD). Adjustable from app settings. */
  maxSpreadPoints: number;
  lastFeatures?: FeatureSet;
  setupProgress?: SetupProgress;
  lastSignalReason?: string;
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
    currency: 'USD',
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
    aiTradingEnabled: Boolean(CONFIG.aiTradingEnabled),
    timezoneTradingEnabled: true,
    maxSpreadPoints: CONFIG.maxSpreadPoints,
  };

  private pendingCommands: any[] = [];
  private closedTrades: any[] = [];
  private positionStates: Record<string, PositionState> = {};
  private openPositionTickets: Set<string> = new Set();
  private lastTradeTime = 0;
  private cooldowns: Record<'BUY' | 'SELL', number> = { BUY: 0, SELL: 0 };
  private lastSnapshotTime = 0;
  // Cached latest regime classification (updated every heartbeat). Also
  // exposed to the mobile UI via the Socket.IO EA_HEARTBEAT payload so the
  // dashboard renders the current regime, confidence, and compatible strategies.
  private latestRegime: MarketRegimeClassification | null = null;
  // Cached latest ensemble decision (last signal that went through the gate,
  // or null). Used so DNA init can attach full ensemble explainability even
  // if the ticket-correlation step happens on a later heartbeat.
  private latestEnsembleDecision: EnsembleDecision | null = null;
  // Best-effort correlation between a just-generated signal's confidence and
  // the eventual MT5 ticket it produces (there's no signal-id round-trip
  // through the EA yet, so this is a short-lived, direction-keyed cache, not
  // a guaranteed match). Used only to avoid hardcoding DNA confidence.
  private lastSignalConfidence: {
    direction: 'BUY' | 'SELL';
    finalConfidence: number;
    aiConfidence: number | null;
    modelVersion: string | null;
    timestamp: number;
    // Ensemble + regime extras (preserves DNA backward compat: all optional)
    ensembleScore?: number;
    marketRegime?: string;
    regimeConfidence?: number;
    fnnConfidence?: number | null;
    cnnConfidence?: number | null;
    lstmConfidence?: number | null;
    detectedPattern?: string;
    patternConfidence?: number;
    explainability?: any;
    ensembleDecision?: 'ACCEPT' | 'REJECT' | 'SHADOW_REJECT';
    fnnOutput?: any;
    cnnOutput?: any;
    lstmOutput?: any;
    ensembleOutput?: any;
  } | null = null;

  private featureEngine = new FeatureEngineeringEngine();
  private featureStorage = new FeatureStorage();
  private dnaEngine = new TradeDnaEngine();
  private experienceEngine = new ExperienceEngine();
  private lastSignal: TradeSignal | null = null;
  private trailingProfitReentries: Record<string, number> = {};

  constructor(private io: Server) {}

  async init() {
    await initDb();
    try {
      await gateConfig.init();
    } catch (e) {
      logger.warn('gateConfig.init failed (safe fallbacks active)', e);
    }
    await this.rehydrateOpenPositions();
    logger.success('Trading Engine initialized with PostgreSQL');
  }

  /**
   * Crash recovery: on startup, reload any positions that were still open
   * when the process last stopped, so trailing-stop phase and DNA tracking
   * survive a restart instead of silently resetting to phase 1 / no DNA.
   */
  private async rehydrateOpenPositions() {
    try {
      const openPositions = await prisma.position.findMany({
        where: { isOpen: true },
        include: { tradeDna: true },
      });

      for (const pos of openPositions) {
        const ticket = pos.ticket;
        this.openPositionTickets.add(ticket);

        this.positionStates[ticket] = {
          ticket,
          signalId: uuidv4(),
          symbol: pos.symbol,
          direction: pos.direction === 'BUY' ? 'BUY' : 'SELL',
          openPrice: Number(pos.openPrice),
          currentSL: pos.sl ? Number(pos.sl) : 0,
          currentPrice: Number(pos.currentPrice),
          phase: pos.trailingPhase || 1,
          // Scale-in/TP levels aren't persisted anywhere yet (they're computed
          // by the signal/risk layer at entry time), so they can't be restored;
          // trailingStopManager degrades gracefully when these are empty.
          scaleInLevels: [],
          tpLevels: [],
          spread: 0,
          pipSize: 0.01,
          pointSize: 0.001,
        };

        if (pos.tradeDna) {
          const dna = pos.tradeDna;
          // TradeDnaEngine has no "load existing record" method, only
          // initializeTradeDNA (new) and finalizeTradeDNA/updateTradeDNA
          // (lookup by ticket). Re-seeding via initializeTradeDNA restores
          // ticket-keyed lookups (getDnaByTicket) so a subsequent trade close
          // can still finalize/save DNA correctly; the DNA's in-memory id and
          // entryTime won't exactly match the original row (createdAt is used
          // as the closest available proxy for entryTime).
          this.dnaEngine.initializeTradeDNA(
            ticket,
            dna.symbol,
            dna.direction === 'BUY' ? 'BUY' : 'SELL',
            Number(dna.entryPrice),
            Number(dna.stopLoss),
            Number(dna.takeProfit),
            Number(dna.lotSize),
            Number(dna.riskPercent),
            dna.entryFeatures as any,
            dna.modelVersion,
            Number(dna.aiConfidence)
          );
        }
      }

      if (openPositions.length > 0) {
        logger.success(`Rehydrated ${openPositions.length} open position(s) after restart`);
      }
    } catch (error) {
      logger.error('Failed to rehydrate open positions on startup', error);
    }
  }

  // Getters
  getAccountState(): AccountState {
    return { ...this.accountState };
  }

  /** Apply mobile/settings flags without requiring a full EA heartbeat. */
  applyBotConfig(cfg: {
    autoTradingEnabled?: boolean;
    aiTradingEnabled?: boolean;
    timezoneTradingEnabled?: boolean;
    maxSpreadPoints?: number;
  }) {
    if (cfg.autoTradingEnabled !== undefined) {
      this.accountState.autoTradingEnabled = !!cfg.autoTradingEnabled;
    }
    if (cfg.aiTradingEnabled !== undefined) {
      this.accountState.aiTradingEnabled = !!cfg.aiTradingEnabled;
      CONFIG.aiTradingEnabled = this.accountState.aiTradingEnabled;
    }
    if (cfg.timezoneTradingEnabled !== undefined) {
      this.accountState.timezoneTradingEnabled = !!cfg.timezoneTradingEnabled;
    }
    if (cfg.maxSpreadPoints !== undefined && Number.isFinite(cfg.maxSpreadPoints) && cfg.maxSpreadPoints > 0) {
      this.accountState.maxSpreadPoints = Math.round(cfg.maxSpreadPoints);
    }
    this.io.emit('BOT_CONFIG', {
      autoTradingEnabled: this.accountState.autoTradingEnabled,
      aiTradingEnabled: this.accountState.aiTradingEnabled,
      timezoneTradingEnabled: this.accountState.timezoneTradingEnabled,
      maxSpreadPoints: this.accountState.maxSpreadPoints,
    });
  }

  getPendingCommands(): any[] {
    return [...this.pendingCommands];
  }
  getClosedTrades(): any[] {
    return [...this.closedTrades];
  }
  async getClosedTradesWithJournal(range: 'today' | 'week' | 'month' | 'all' = 'all'): Promise<any[]> {
    const memory = [...this.closedTrades];
    try {
      // Step 1: REAL MT5 JOURNAL as #1 source of truth (AdvancedTradeJournal table)
      // This table carries the EXACT P&L that MT5 reports (profitDollars / profitPips / outcome)
      const dbJournal = await getAdvancedJournalClosedTrades({ range, limit: 200 });

      // Step 2: secondary — journalManager (PostgreSQL or JSONL fallback)
      const entries = await journalManager.getAllEntries({ limit: 200 });
      const byTicket = new Map(entries.map(e => [String(e.ticket), e]));
      const merged = new Map<string, any>();

      // Merge memory first
      for (const t of memory) {
        const ticket = String(t.ticket);
        merged.set(ticket, { ...t, _source: 'memory' });
      }
      // Merge DB AdvancedJournal ON TOP (highest priority — real MT5 profit!)
      for (const j of dbJournal) {
        merged.set(String(j.ticket), { ...(merged.get(String(j.ticket)) || {}), ...j, _source: 'advancedJournal' });
      }
      // Merge journalManager last (lowest priority, but preserve outcome)
      for (const e of entries) {
        const ticket = String(e.ticket);
        const existing = merged.get(ticket);
        const outcomeVal = e.outcome === 'WIN' || e.outcome === 'LOSS' || e.outcome === 'BREAKEVEN' ? e.outcome : existing?.outcome;
        const rawDollars = (e.profitDollars !== undefined && e.profitDollars !== null) ? Number(e.profitDollars) : NaN;
        const rawPips = (e.profitPips !== undefined && e.profitPips !== null) ? Number(e.profitPips) : NaN;
        const m: any = existing || {
          ticket,
          symbol: e.symbol,
          type: e.direction,
          lots: Number(e.lotSize || 0.01),
          openPrice: Number(e.entryPrice || 0),
          closePrice: Number(e.executionPrice || e.entryPrice || 0),
          openTime: e.entryTimestamp ? new Date(e.entryTimestamp).getTime() : null,
          closeTime: e.closeTimestamp ? new Date(e.closeTimestamp).getTime() : Date.now(),
          sl: Number(e.sl || 0),
          tp: Number(e.tp || 0),
          stopLoss: Number(e.sl || 0),
          takeProfit: Number(e.tp || 0),
          _source: 'journalManager',
        };
        const existingProfit = Number(existing?.profit ?? existing?.pnl ?? NaN);
        const memoryHasProfit = Number.isFinite(existingProfit) && Math.abs(existingProfit) > 0.0001;
        const journalProfitFinite = Number.isFinite(rawDollars) && Math.abs(rawDollars) > 0.0001;
        const finalProfit = memoryHasProfit && !existing?._fromAdvancedJournal
          ? existingProfit
          : (existing?._fromAdvancedJournal && Number.isFinite(Number(existing?.profit ?? NaN))
              ? Number(existing.profit)
              : (journalProfitFinite
                  ? rawDollars
                  : (existingProfit || rawDollars || 0)));
        const finalPips = Number.isFinite(rawPips) && Math.abs(rawPips) > 0.0001
          ? rawPips
          : (Number(existing?.profitPips) ?? (Number.isFinite(rawPips) ? rawPips : 0));
        merged.set(ticket, {
          ...m,
          profit: finalProfit,
          pnl: finalProfit,
          profitPips: finalPips,
          outcome: outcomeVal || m?.outcome || existing?.outcome,
        });
      }
      const arr = Array.from(merged.values());
      arr.sort((a, b) => Number(b.closeTime || 0) - Number(a.closeTime || 0));
      return arr.slice(0, 200);
    } catch (e) {
      return memory;
    }
  }
  getDna(): TradeDNA[] {
    return this.dnaEngine.getAllDna();
  }
  getLessons(): Lesson[] {
    return this.experienceEngine.getLessons();
  }

  getLiveWatch() {
    return liveTradeObserver.getStatus();
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
      let savedCandleId: string | undefined;

      // 1. Save Tick Data
      if (payload.price && payload.spread !== undefined) {
        await saveTick({
          symbol: payload.symbol,
          bid: payload.price - (payload.spread / 2),
          ask: payload.price + (payload.spread / 2),
          spread: payload.spread,
          volume: 0,
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
        savedCandleId = savedCandle?.id;
      }

      // 3. Save Account Snapshot (once per 5 seconds)
      const now = Date.now();
      if (now - this.lastSnapshotTime > 5000) {
        this.lastSnapshotTime = now;
        await saveAccountSnapshot({
          balance: payload.balance,
          equity: payload.equity,
          margin: 0,
          floatingPL: payload.positions?.reduce((sum, p) => sum + (p.profit || 0), 0) || 0,
          openPositions: payload.positions?.length || 0,
          currency: payload.currency || 'USD',
        });
      }

      // 4. Save FeatureSet (with candleId FK if available)
      try {
        const winRate = await this.featureStorage.computeSimilarSetupWinRate(features);
        const enriched = { ...features, similarSetupWinRate: winRate };
        const featureToSave = savedCandleId
          ? { ...enriched, candleId: savedCandleId }
          : enriched;
        await this.featureStorage.saveFeature(featureToSave);
      } catch (featureErr) {
        logger.error('Failed to save FeatureSet', featureErr);
      }

      // 5. Save Positions
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
      payload.timeframe || 'M5',
      candlesReversed,
      ema20,
      ema50,
      atr14,
      payload.spread || 0,
      payload.pipSize || 0.01
    );

    // --- Market Regime Detection (Phase 1) ---
    try {
      const last20 = candlesReversed.slice(-20);
      const prev20 = candlesReversed.slice(-40, -20);
      const range3 = last20.slice(-3).reduce((s, c: any) => s + Math.abs((c.high ?? c.yHigh ?? c.close) - (c.low ?? c.yLow ?? c.close)), 0);
      const rangePrev3 = prev20.slice(-3).reduce((s, c: any) => s + Math.abs((c.high ?? c.yHigh ?? c.close) - (c.low ?? c.yLow ?? c.close)), 0);
      let avgBodyPct = 0.5;
      if (last20.length) {
        const bodyPcts = last20.map((c: any) => {
          const hi = Number(c.high ?? c.yHigh ?? c.close);
          const lo = Number(c.low ?? c.yLow ?? c.close);
          const op = Number(c.open ?? c.yOpen ?? c.close);
          const cl = Number(c.close ?? c.yClose ?? 0);
          const total = hi - lo || 1;
          return Math.min(1, Math.abs(cl - op) / total);
        });
        avgBodyPct = bodyPcts.reduce((s, v) => s + v, 0) / bodyPcts.length;
      }
      const bbWidthRaw = Number(features.bbWidth ?? features.bbPercentWidth ?? 0);
      const bbWidthRatio = Math.abs(bbWidthRaw - 1) < 0.1 ? 1 : Math.max(0.3, Math.min(2, 1 + (bbWidthRaw - 0.04) * 8));
      const rsiCenter = Number(features.rsiStrength ?? 50);
      const emaGapPips = Math.abs(ema20 - ema50);
      const emaGapAtrRatio = atr14 > 0 ? emaGapPips / atr14 : 0;
      const volRatio = features.volumeRatio ?? 1;
      const adx = Number(features.adxValue ?? 20);

      this.latestRegime = marketRegimeDetector.classify({
        adxValue: adx,
        atrRatio: Number(features.atrRatio ?? 1),
        bbWidthRatio,
        recentCandleBodyPctAvg: avgBodyPct,
        rangeExpansionRatio: rangePrev3 > 0 ? Math.max(0.2, Math.min(5, range3 / rangePrev3)) : 1,
        spreadStatus: features.spreadStatus ?? ('NORMAL' as SpreadStatus),
        volatility: features.volatility ?? ('MEDIUM' as Volatility),
        marketSession: features.marketSession ?? ('ASIA' as MarketSession),
        nearbyHighImpactNews: !!(features.newsImpact === 'HIGH' || features.newsImpact === 'EXTREME'),
        volumeRatio: volRatio,
        emaGapAtrRatio,
        rsiDeviationFrom50: Math.abs(rsiCenter - 50),
      });
    } catch (regimeErr) {
      monitoring.trackError(`Regime detection failed: ${regimeErr}`, 'ERROR');
      this.latestRegime = null;
    }

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
      if (currentTickets.has(ticket)) continue;

      try {
        this.openPositionTickets.delete(ticket);
        const liveExcursion = liveTradeObserver.finalize(ticket);
        const closedTrade = (payload.closedTrades || []).find(t => String(t.ticket) === ticket);
        const dna = this.dnaEngine.getDnaByTicket(ticket);
        const posState = this.positionStates[ticket];
        const dnaAny: any = dna || {};
        const openPx = Number(
          closedTrade?.openPrice ??
          dnaAny.entryPrice ??
          posState?.openPrice ??
          0
        );
        const closePriceRaw = Number(closedTrade?.closePrice ?? this.accountState.price);
        const lots = Number(
          closedTrade?.lots ??
          dnaAny.lotSize ??
          dnaAny.lots ??
          0.01
        );
        const dirRaw = dna?.direction ?? closedTrade?.type ?? posState?.direction ?? 'BUY';
        const dir = (dirRaw === 'BUY' || dirRaw === 0 || String(dirRaw).toUpperCase() === 'BUY') ? 'BUY' : 'SELL';
        const pipVal = Number(this.accountState.pipValue || closedTrade?.pipValue || 1);
        const pipSz = Number(this.accountState.pipSize || closedTrade?.pipSize || 0.01);
        const rawDiff = dir === 'BUY' ? (closePriceRaw - openPx) : (openPx - closePriceRaw);
        const pipsComputed = pipSz > 0 ? rawDiff / pipSz : rawDiff;
        const computedProfit = pipsComputed * lots * pipVal;
        const reportedProfit = Number(closedTrade?.profit ?? closedTrade?.pnl ?? NaN);
        const profit = Number.isFinite(reportedProfit) && Math.abs(reportedProfit) > 0.0001
          ? reportedProfit
          : computedProfit;
        const closePrice = closePriceRaw;
        let finalizedDna: any = null;

        if (dna) {
          const lessons = this.experienceEngine.analyzeTrade(dna);
          finalizedDna = this.dnaEngine.finalizeTradeDNA(
            ticket,
            closePrice,
            features,
            profit,
            0,
            0,
            lessons.map(l => l.title),
            lessons.map(l => l.description)
          );

          // --- Post-close online-learning metrics (Phase 1 additive) ---
          // These fields are nullable in the schema, so if DNA was created
          // before ensemble/regime tracking existed (or if no ensemble fired
          // for this ticket), we simply don't set them.
          if (finalizedDna) {
            const confEnt: any = dna;
            const ensOutput: any = confEnt.ensembleOutput || null;
            const entryFnnConf = Number(confEnt.aiConfidence ?? confEnt.fnnConfidence ?? 0) || 0;
            const outcomeSign =
              finalizedDna.outcome === 'WIN' ? 1
                : finalizedDna.outcome === 'LOSS' ? -1
                  : 0;
            const direction = String(finalizedDna.direction || dna?.direction || 'BUY').toUpperCase();

            // Confidence error: |AI's confidence - actual outcome|
            // (outcome ∈ {1 win, -1 loss, 0 BE}; AI conf ∈ [0,1] so we map
            // direction-aligned confidence to [0,1] for "would-win" expectation.)
            const aiExpectedWin = entryFnnConf > 0
              ? (direction === 'BUY' ? entryFnnConf : entryFnnConf)
              : 0.5;
            const accuracyTarget = outcomeSign > 0 ? 1 : outcomeSign < 0 ? 0 : 0.5;
            const confidenceError = Math.abs(aiExpectedWin - accuracyTarget);

            // Prediction error: ensemble voted BUY but closed as LOSS → 1.
            // If ensemble was shadow-reject and trade actually lost → 0 (correct).
            let predictionError = 0;
            let misclassificationReason: string | null = null;
            if (ensOutput?.proposedDirection && outcomeSign !== 0) {
              const ensDir = String(ensOutput.proposedDirection).toUpperCase();
              const ensFinalizedCorrect = outcomeSign > 0
                ? (ensDir === direction)
                : (ensDir !== direction);
              predictionError = ensFinalizedCorrect ? 0 : 1;
              if (predictionError > 0) {
                const lossPips = Math.abs(Number(finalizedDna.profitPips) || 0);
                const deep = (finalizedDna as any).analysis?.deep || null;
                const slHit = deep?.slTpSizing?.slTooSmall ? 'SL too small; ' : '';
                const trendHit = deep?.trendAdherence?.ignored ? 'counter-trend; ' : '';
                const newsHit = deep?.newsImpact?.affected ? 'news moved price; ' : '';
                const spreadHit = deep?.spreadImpact?.responsible ? 'spread cost; ' : '';
                misclassificationReason =
                  `Ensemble=${ensDir}, final=${finalizedDna.outcome}. ` +
                  `${slHit}${trendHit}${newsHit}${spreadHit}Regime=${String(confEnt.marketRegime || (ensOutput?.regime?.regime) || 'UNKNOWN')}. Loss=${lossPips.toFixed(1)} pips.`;
              }
            }

            // Pattern success: if entry pattern detected, did it deliver?
            const pattern = confEnt.detectedPattern || ensOutput?.explainability?.patternDetected || null;
            const patternConf = Number(confEnt.patternConfidence || ensOutput?.cnn?.patternConfidence || 0);
            const patternSuccess = pattern && pattern !== 'NONE'
              ? (outcomeSign > 0 ? 'SUCCESS' : outcomeSign < 0 ? 'FAILURE' : 'BREAKEVEN')
              : null;
            void patternConf;

            // Market regime tag
            const marketRegime =
              confEnt.marketRegime || ensOutput?.regime?.regime || this.latestRegime?.regime || null;
            const regimeConf =
              Number(confEnt.regimeConfidence || ensOutput?.regime?.confidence || this.latestRegime?.confidence || 0);

            // Spread + slippage = execution quality proxy (0-1, higher = better)
            const spreadCostPips = Number(this.accountState.spread || 0) / (this.accountState.pipSize || 0.01);
            const slPips = Math.abs(Number(finalizedDna.stopLoss || 0) - Number(finalizedDna.entryPrice || 0)) / (this.accountState.pipSize || 0.01) || 10;
            const spreadRatio = Math.min(1, spreadCostPips / Math.max(1, slPips));
            const executionQuality = Math.max(0, 1 - spreadRatio * 2);
            const slippagePips = Number((closedTrade as any)?.slippagePips || (closedTrade as any)?.slippage || 0);
            const entryLatencyMs = Number((closedTrade as any)?.entryLatencyMs || 0);

            // Execution quality score (0-1), higher = better
            const executionQualityFinal = Math.max(0, 1 - (
              spreadRatio * 0.5 +
              Math.min(1, slippagePips / Math.max(1, slPips)) * 0.3 +
              Math.min(1, entryLatencyMs / 1000) * 0.2
            ));

            // Merge into finalizedDna so saveTradeDna() (which accepts the
            // new fields) picks them up on the upsert inside the transaction.
            finalizedDna.fnnOutput = confEnt.fnnOutput || ensOutput?.fnn || null;
            finalizedDna.cnnOutput = confEnt.cnnOutput || ensOutput?.cnn || null;
            finalizedDna.lstmOutput = confEnt.lstmOutput || ensOutput?.lstm || null;
            finalizedDna.ensembleOutput = confEnt.ensembleOutput || ensOutput || null;
            finalizedDna.marketRegime = marketRegime;
            finalizedDna.regimeConfidence = regimeConf || null;
            finalizedDna.executionQuality = Number.isFinite(executionQualityFinal) ? executionQualityFinal : executionQuality;
            finalizedDna.slippagePips = slippagePips || null;
            finalizedDna.entryLatencyMs = entryLatencyMs || null;
            finalizedDna.detectedPattern = pattern;
            finalizedDna.patternConfidence = patternConf || null;
            finalizedDna.misclassificationReason = misclassificationReason;
            finalizedDna.confidenceError = Number.isFinite(confidenceError) ? confidenceError : null;
            finalizedDna.predictionError = Number.isFinite(predictionError) ? predictionError : null;
            // Tag pattern success into lessons + mistakes for dashboardability
            if (patternSuccess && !finalizedDna.lessons.includes(patternSuccess)) {
              finalizedDna.lessons.push(`Pattern ${pattern}: ${patternSuccess}`);
            }
          }
        }

        const direction =
          finalizedDna?.direction ||
          (closedTrade?.type === 'BUY' || closedTrade?.type === 0 ? 'BUY' : 'SELL');
        const profitPips = Number(
          finalizedDna?.profitPips ??
            closedTrade?.profitPips ??
            (this.accountState.pipSize ? profit / (this.accountState.pipValue || 1) : profit)
        );
        const outcome: 'WIN' | 'LOSS' | 'BREAKEVEN' =
          profitPips > 0.5 ? 'WIN' : profitPips < -0.5 ? 'LOSS' : 'BREAKEVEN';

        // Track trailing-stop profitable closures to limit re-entries (per-symbol)
        // If a trade closed by trailing stop in profit, grant only 2 re-entries for that symbol.
        // Reset allowance on loss.
        try {
          const reasonStr = String((closedTrade && (closedTrade as any).reason) || '').toUpperCase();
          const closedByTrailing = reasonStr.includes('TRAIL') || reasonStr.includes('TRAILING') || reasonStr.includes('STOP');
          const sym = this.accountState.symbol || (closedTrade && (closedTrade as any).symbol) || null;
          if (sym) {
            if (outcome === 'WIN' && closedByTrailing) {
              this.trailingProfitReentries[sym] = 2;
              tradingLogger.info(`Trailing-stop profit detected for ${sym}; granting 2 re-entries`);
            } else if (outcome === 'LOSS') {
              this.trailingProfitReentries[sym] = 0;
              tradingLogger.info(`Loss detected for ${sym}; clearing trailing re-entry allowance`);
            }
          }
        } catch (e) { /* non-fatal */ }

        // Atomically persist DNA + position close + journal update: either all
        // of these DB writes land, or none do (no more "DNA saved but position
        // still marked open" split-brain state on partial failure).
        await monitoring.timeAsync(
          'database',
          () =>
            prisma.$transaction(async (tx: any) => {
              if (finalizedDna) {
                await saveTradeDna(finalizedDna as any, tx);
              }
              await tx.position.updateMany({
                where: { ticket },
                data: { isOpen: false, closeTimestamp: new Date() },
              });
              if (finalizedDna) {
                await journalManager.updateEntry(
                  ticket,
                  {
                    outcome,
                    profitPips,
                    profitPercent: Number(finalizedDna.profitPercent) || 0,
                    profitDollars: profit,
                    closeTimestamp: new Date(),
                    durationMinutes: finalizedDna.durationMinutes,
                    reasonForExit: closedTrade?.reason || 'CLOSED_BY_BROKER',
                  },
                  tx
                );
              }
            }),
          'closeTradeTransaction'
        );

        // Continuous learning (file-system side effect) and DB PostTradeAnalysis
        // only run after the transaction above has committed successfully.
        try {
          const swingHighs = features?.swingHighs?.map((s: any) => s.price) || calculateSwingHighs(this.accountState.candles.slice().reverse(), 2);
          const swingLows = features?.swingLows?.map((s: any) => s.price) || calculateSwingLows(this.accountState.candles.slice().reverse(), 2);

        const analysis = await continuousLearning.onTradeCompleted({
            ticket,
            symbol: this.accountState.symbol,
            direction: direction === 'BUY' ? 'BUY' : 'SELL',
            outcome,
            profitPips,
            profitDollars: profit,
            profitPercent: finalizedDna?.profitPercent,
            entryPrice: finalizedDna?.entryPrice || closedTrade?.openPrice,
            closePrice,
            sl: finalizedDna?.stopLoss,
            tp: finalizedDna?.takeProfit,
            lotSize: finalizedDna?.lotSize,
            riskPercent: finalizedDna?.riskPercent || 1,
            aiConfidence: finalizedDna?.aiConfidence,
            modelVersion: finalizedDna?.modelVersion || modelManager.getProductionVersion() || undefined,
            entryFeatures: finalizedDna?.entryFeatures || features,
            closeFeatures: features,
            marketSession: features?.marketSession,
            entryTimestamp: finalizedDna?.entryTimestamp,
            closeTimestamp: Date.now(),
            spreadAtEntry: this.accountState.spread,
            pipSize: this.accountState.pipSize,
            atr14: this.accountState.atr14,
            swingHighs,
            swingLows,
            durationMinutes: finalizedDna?.durationMinutes,
            // Real MFE/MAE from live observer (no random fallback when available)
            maxFavorableExcursionPips: liveExcursion?.mfePips,
            maxAdverseExcursionPips: liveExcursion?.maePips,
            // --- Ensemble + Online Learning Phase 1 extras (all nullable) ---
            fnnOutput: finalizedDna?.fnnOutput,
            cnnOutput: finalizedDna?.cnnOutput,
            lstmOutput: finalizedDna?.lstmOutput,
            ensembleOutput: finalizedDna?.ensembleOutput,
            ensembleScore: finalizedDna?.ensembleOutput?.finalScore ?? null,
            marketRegime: finalizedDna?.marketRegime,
            regimeConfidence: finalizedDna?.regimeConfidence ?? null,
            detectedPattern: finalizedDna?.detectedPattern,
            patternConfidence: finalizedDna?.patternConfidence ?? null,
            patternSuccess:
              finalizedDna?.detectedPattern && finalizedDna.detectedPattern !== 'NONE'
                ? outcome === 'WIN' ? 'SUCCESS' : outcome === 'LOSS' ? 'FAILURE' : 'BREAKEVEN'
                : null,
            misclassificationReason: finalizedDna?.misclassificationReason ?? null,
            confidenceError: finalizedDna?.confidenceError ?? null,
            predictionError: finalizedDna?.predictionError ?? null,
            executionQuality: finalizedDna?.executionQuality ?? null,
            slippagePips: finalizedDna?.slippagePips ?? null,
            entryLatencyMs: finalizedDna?.entryLatencyMs ?? null,
          });

          // Persist structured analysis to PostgreSQL PostTradeAnalysis table
          // for future model training & analytics dashboard queries.
          try {
            await savePostTradeAnalysis({
              ticket,
              symbol: this.accountState.symbol,
              direction: direction === 'BUY' ? 'BUY' : 'SELL',
              outcome,
              profitPips,
              profitDollars: profit,
              modelVersion: finalizedDna?.modelVersion || modelManager.getProductionVersion() || undefined,
              aiConfidence: finalizedDna?.aiConfidence,
              analysis: analysis.analysis,
              lessons: analysis.lessons,
              labeledSampleId: analysis.labeledSampleId,
            });
          } catch (dbErr) {
            monitoring.trackError(`PostTradeAnalysis DB save failed for ${ticket}: ${dbErr}`, 'ERROR');
          }
        } catch (e) {
          monitoring.trackError(`Continuous learning failed for ${ticket}: ${e}`, 'ERROR');
        }

        monitoring.trackBrokerResponse(true, undefined, 'TRADE_CLOSED');
        const posStateClose = this.positionStates[ticket];
        const dnaAnyClose: any = finalizedDna || dna || {};
        const dnaSl = Number(dnaAnyClose.stopLoss || 0);
        const dnaTp = Number(dnaAnyClose.takeProfitLevels?.[0] || 0);
        this.closedTrades.unshift({
          ticket,
          symbol: closedTrade?.symbol || this.accountState.symbol,
          type: closedTrade?.type || dnaAnyClose.direction || 'BUY',
          lots: Number(closedTrade?.lots || dnaAnyClose.lots || dnaAnyClose.lotSize || 0),
          openPrice: Number(closedTrade?.openPrice || dnaAnyClose.entryPrice || 0),
          closePrice,
          profit,
          pnl: profit,
          profitPips,
          outcome,
          sl: Number(closedTrade?.sl || posStateClose?.currentSL || dnaSl || 0),
          tp: Number(closedTrade?.tp || posStateClose?.tpLevels?.[0] || dnaTp || 0),
          stopLoss: Number(closedTrade?.sl || posStateClose?.currentSL || dnaSl || 0),
          takeProfit: Number(closedTrade?.tp || posStateClose?.tpLevels?.[0] || dnaTp || 0),
          openTime: closedTrade?.openTime || dnaAnyClose.entryTime || null,
          closeTime: closedTrade?.closeTime || Date.now(),
        });
        if (this.closedTrades.length > 200) this.closedTrades.pop();

        // --- HUMAN-IN-THE-LOOP: proposal engine generates CAUTIOUS suggestions. ---
        // NEVER auto-applies; every proposed gate/requirement change ALWAYS has
        // status=PENDING_APPROVAL and waits for the user to click APPROVE via API.
        try {
          const lastN = this.closedTrades.slice(0, 100);
          const wins = lastN.filter(t => Number(t.profit || t.pnl || 0) > 0);
          const losses = lastN.filter(t => Number(t.profit || t.pnl || 0) < 0);
          const winRate = lastN.length > 0 ? wins.length / lastN.length : 0;
          const grossWins = wins.reduce((s, t) => s + Math.max(0, Number(t.profit || t.pnl || 0)), 0);
          const grossLosses = Math.max(0.01, Math.abs(losses.reduce((s, t) => s + Math.min(0, Number(t.profit || t.pnl || 0)), 0)));
          const profitFactor = grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? 5 : 0);
          const avgPnl = lastN.length > 0 ? lastN.reduce((a, t) => a + Number(t.profit || t.pnl || 0), 0) / lastN.length : 0;
          const balance = Number(this.accountState.balance || 0);
          const equity = Number(this.accountState.equity || balance);
          const avgDrawdownPct = balance > 0 ? Math.max(0, (balance - equity) / balance) * 100 : 0;

          const dirStats: any = { BUY: { trades: 0, wins: 0 }, SELL: { trades: 0, wins: 0 } };
          for (const t of lastN) {
            const d = String(t.type || 'BUY').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
            dirStats[d].trades += 1;
            if (Number(t.profit || t.pnl || 0) > 0) dirStats[d].wins += 1;
          }
          const perDirection = {
            BUY: { trades: dirStats.BUY.trades, winRate: dirStats.BUY.trades > 0 ? dirStats.BUY.wins / dirStats.BUY.trades : 0 },
            SELL: { trades: dirStats.SELL.trades, winRate: dirStats.SELL.trades > 0 ? dirStats.SELL.wins / dirStats.SELL.trades : 0 },
          };

          const perfSample = {
            totalTrades: lastN.length,
            winRate,
            avgPnl,
            profitFactor,
            avgDrawdownPct,
            perDirection,
            signalCounts: undefined,
          };
          await proposalEngine.maybeGenerateProposals(perfSample);
        } catch (pe) {
          monitoring.trackError(`ProposalEngine check failed (safe; no gates changed): ${pe}`, 'ERROR');
        }

        delete this.positionStates[ticket];
        this.io.emit('TRADE_CLOSED', {
          ticket,
          profit,
          pnl: profit,
          profitPips,
          outcome,
          closePrice,
          closeTime: Date.now(),
          serverTs: Date.now(),
        });
      } catch (error) {
        // Never let one bad position's close-handling abort processing of the
        // rest of processMT5Update. Re-add the ticket so we retry on next tick
        // rather than silently losing track of it.
        this.openPositionTickets.add(ticket);
        monitoring.trackError(`Failed to process trade close for ${ticket}: ${error}`, 'ERROR');
        logger.error(`Failed to process trade close for ${ticket}`, error);
      }
    }

    // Initialize DNA for new positions
    for (const pos of this.accountState.positions) {
      const ticket = String(pos.ticket);
      if (!this.openPositionTickets.has(ticket)) {
        this.openPositionTickets.add(ticket);
        try {
          const direction = (pos.type === 'BUY' || pos.type === 0) ? 'BUY' : 'SELL';
          const entryPrice = pos.openPrice || pos.price || this.accountState.price;
          const sl = pos.sl || 0;
          const tp = pos.tp || 0;
          const lotSize = pos.volume || pos.lots || 0.01;
          // Best-effort: use the confidence from the most recent matching
          // signal (within 2 minutes, same direction) rather than a
          // hardcoded placeholder. This is a heuristic correlation, not a
          // guaranteed signal-id→ticket match — a proper fix requires the EA
          // to echo back the originating signal id with the executed order,
          // which it does not do today.
          const matchedSignal =
            this.lastSignalConfidence &&
            this.lastSignalConfidence.direction === direction &&
            Date.now() - this.lastSignalConfidence.timestamp < 120000
              ? this.lastSignalConfidence
              : null;
          const confidence = matchedSignal ? matchedSignal.finalConfidence : 0.5;

          const dna = this.dnaEngine.initializeTradeDNA(
            ticket,
            this.accountState.symbol,
            direction,
            entryPrice,
            sl,
            tp,
            lotSize,
            CONFIG.riskPercentPerTrade,
            features,
            matchedSignal?.modelVersion || undefined,
            confidence
          );

          // --- NEW: Stitch ensemble + regime extras into DNA (Phase 1, additive) ---
          if (matchedSignal) {
            const extras = matchedSignal as any;
            // dnaEngine object (in-memory) → saveTradeDna()'s Prisma upsert
            // signature accepts these new fields; DNA read-back works as they
            // live in Postgres columns now.
            (dna as any).fnnOutput = extras.fnnOutput;
            (dna as any).cnnOutput = extras.cnnOutput;
            (dna as any).lstmOutput = extras.lstmOutput;
            (dna as any).ensembleOutput = extras.ensembleOutput;
            (dna as any).marketRegime = extras.marketRegime ?? this.latestRegime?.regime;
            (dna as any).regimeConfidence = extras.regimeConfidence ?? this.latestRegime?.confidence;
            (dna as any).detectedPattern = extras.detectedPattern;
            (dna as any).patternConfidence = extras.patternConfidence;
            // Cache these on DNA so close-time finalization can compute errors
            // even if lastSignalConfidence was overwritten by later signals.
            (dna as any).fnnConfidence = extras.fnnConfidence;
            (dna as any).cnnConfidence = extras.cnnConfidence;
            (dna as any).lstmConfidence = extras.lstmConfidence;
            (dna as any).aiConfidence = confidence;
          } else {
            // Even without a matched signal, attach the current regime so
            // every DNA has a regime label for per-regime performance analytics.
            (dna as any).marketRegime = this.latestRegime?.regime ?? null;
            (dna as any).regimeConfidence = this.latestRegime?.confidence ?? null;
          }

          const savedDna = await saveTradeDna(dna as any);

          // Wire the live trade-open path into the Advanced Trade Journal
          // (previously only manual API routes ever created journal entries).
          // Phase 1: also persist ensemble/regime explainability into the
          // journal so the mobile dashboard can render trade explanations.
          const ens = (matchedSignal as any)?.ensembleOutput || null;
          const regime = (dna as any).marketRegime || null;
          const regimeConf = (dna as any).regimeConfidence || null;
          const pattern = (dna as any).detectedPattern || null;
          const patternConf = (dna as any).patternConfidence || null;
          const fnnConf = Number((matchedSignal as any)?.fnnConfidence ?? confidence) || null;
          const cnnConf = Number((matchedSignal as any)?.cnnConfidence ?? null) || null;
          const lstmConf = Number((matchedSignal as any)?.lstmConfidence ?? null) || null;
          const ensembleScore = Number((matchedSignal as any)?.ensembleScore ?? null) || null;
          const ensembleDecision = (matchedSignal as any)?.ensembleDecision || null;
          const explainability = (matchedSignal as any)?.explainability || null;

          await journalManager.createEntry({
            ticket,
            symbol: this.accountState.symbol,
            direction,
            marketSnapshot: features,
            marketSession: features?.marketSession || 'UNKNOWN',
            indicators: features,
            featureSet: features,
            aiConfidence: confidence,
            entryPrice,
            executionPrice: entryPrice,
            slippage: 0,
            spreadAtEntry: this.accountState.spread || 0,
            sl,
            tp,
            lotSize,
            riskPercent: dna.riskPercent,
            outcome: 'OPEN',
            profitPips: 0,
            profitPercent: 0,
            profitDollars: 0,
            entryTimestamp: new Date(dna.entryTime),
            tradeDnaId: savedDna?.id,
            // Ensemble + regime + explainability Phase 1 extras:
            marketRegime: regime,
            regimeConfidence: regimeConf,
            detectedPattern: pattern,
            patternConfidence: patternConf,
            fnnConfidence: fnnConf,
            cnnConfidence: cnnConf,
            lstmConfidence: lstmConf,
            ensembleScore,
            ensembleDecision,
            explainability,
          } as any);
          this.io.emit('TRADE_OPENED', {
            ticket,
            symbol: this.accountState.symbol,
            direction,
            entryPrice,
            sl,
            tp,
            lotSize,
            confidence,
            marketRegime: regime,
            pattern,
            openTime: Date.now(),
            serverTs: Date.now(),
          });
        } catch (error) {
          monitoring.trackError(`Failed to initialize DNA/journal for ${ticket}: ${error}`, 'ERROR');
          logger.error(`Failed to initialize DNA/journal for ${ticket}`, error);
        }
      }
    }

    // Trailing Stop + Scale-In Watch
    for (const pos of this.accountState.positions) {
      const ticket = String(pos.ticket);
      try {
        const posDirection: 'BUY' | 'SELL' = (pos.type === 'BUY' || pos.type === 0) ? 'BUY' : 'SELL';
        const matchedSignal =
          this.lastSignal &&
          this.lastSignal.direction === posDirection &&
          Date.now() - this.lastSignal.timestamp < 180000
            ? this.lastSignal
            : null;

        if (!this.positionStates[ticket]) {
          this.positionStates[ticket] = {
            ticket,
            signalId: matchedSignal?.id || uuidv4(),
            symbol: pos.symbol || this.accountState.symbol,
            direction: posDirection,
            openPrice: pos.openPrice || pos.price || this.accountState.price,
            currentSL: Number(pos.sl || 0),
            currentPrice: this.accountState.price,
            phase: 1,
            scaleInLevels: matchedSignal?.scaleInLevels?.map(si => ({
              price: si.price,
              lotSize: si.lotSize,
              newStopLoss: si.newStopLoss,
              isRiskFree: si.isRiskFree ?? true,
            })) || [],
            tpLevels: matchedSignal?.takeProfitLevels?.length
              ? matchedSignal.takeProfitLevels
              : (Number(pos.tp) > 0 ? [Number(pos.tp)] : []),
            spread: this.accountState.spread,
            pipSize: this.accountState.pipSize,
            pointSize: this.accountState.pointSize,
          };
        } else {
          this.positionStates[ticket].currentPrice = this.accountState.price;
          if (!this.positionStates[ticket].currentSL && Number(pos.sl) > 0) {
            this.positionStates[ticket].currentSL = Number(pos.sl);
          }
          if (
            (!this.positionStates[ticket].tpLevels || this.positionStates[ticket].tpLevels.length === 0) &&
            Number(pos.tp) > 0
          ) {
            this.positionStates[ticket].tpLevels = [Number(pos.tp)];
          }
          if (
            (!this.positionStates[ticket].scaleInLevels || this.positionStates[ticket].scaleInLevels.length === 0) &&
            matchedSignal?.scaleInLevels?.length
          ) {
            this.positionStates[ticket].scaleInLevels = matchedSignal.scaleInLevels.map(si => ({
              price: si.price,
              lotSize: si.lotSize,
              newStopLoss: si.newStopLoss,
              isRiskFree: si.isRiskFree ?? true,
            }));
          }
        }

        // --- SCALE-IN EXECUTION WATCH LOOP (Phase 5) ---
        // Fire additional entries when price crosses a scale-in trigger.
        // Track executed levels via Set on positionState to avoid duplicates.
        const ps = this.positionStates[ticket] as any;
        if (!ps._executedScaleIns) ps._executedScaleIns = new Set<number>();
        for (let i = 0; i < ps.scaleInLevels.length; i++) {
          if (ps._executedScaleIns.has(i)) continue;
          const si = ps.scaleInLevels[i];
          const hit = ps.direction === 'BUY'
            ? ps.currentPrice >= si.price
            : ps.currentPrice <= si.price;
          if (hit) {
            ps._executedScaleIns.add(i);
            if (si.lotSize && si.lotSize > 0) {
              this.pendingCommands.push({
                action: ps.direction,
                symbol: ps.symbol,
                lots: si.lotSize,
                sl: si.newStopLoss,
                tp: ps.tpLevels?.[0] || pos.tp || 0,
                reason: `SCALE_IN_E${i + 2}`,
              });
              tradingLogger.info(`Scale-in E${i + 2} fired for ${ticket}`, `price=${ps.currentPrice}`);
              this.io.emit('SCALE_IN_TRIGGERED', {
                ticket,
                entry: i + 2,
                price: ps.currentPrice,
                lotSize: si.lotSize,
                newStopLoss: si.newStopLoss,
              });
            }
          }
        }

        // --- LIVE AI WATCH: rate entry/timing/pattern, track MFE/MAE, adjust ---
        const dnaLive = this.dnaEngine.getDnaByTicket(ticket);
        const watch = liveTradeObserver.observe({
          ticket,
          symbol: pos.symbol || this.accountState.symbol,
          direction: this.positionStates[ticket].direction,
          entryPrice: this.positionStates[ticket].openPrice,
          currentPrice: this.accountState.price,
          sl: this.positionStates[ticket].currentSL || pos.sl || 0,
          tp: pos.tp || 0,
          lotSize: pos.volume || pos.lots || 0.01,
          openTime: dnaLive?.entryTime || Date.now(),
          pipSize: this.accountState.pipSize,
          spread: this.accountState.spread,
          features,
          marketRegime: (dnaLive as any)?.marketRegime || this.latestRegime?.regime,
          detectedPattern: (dnaLive as any)?.detectedPattern,
          patternConfidence: (dnaLive as any)?.patternConfidence,
          aiConfidence: dnaLive?.aiConfidence,
        });

        if (watch.observation) {
          this.dnaEngine.updateTradeDNA(ticket, {
            notes: watch.observation.lesson,
          } as any);
          this.io.emit('TRADE_WATCH', {
            ticket,
            grade: watch.observation.rating.overall,
            score: watch.observation.rating.score,
            mfe: watch.observation.mfePips,
            mae: watch.observation.maePips,
            adjustment: watch.observation.adjustment.action,
            lesson: watch.observation.lesson,
          });
        }

        if (watch.adjustmentCommand) {
          const cmd = watch.adjustmentCommand;
          // Only push if SL actually improves vs current
          const curSl = this.positionStates[ticket].currentSL || 0;
          const dir = this.positionStates[ticket].direction;
          const better =
            dir === 'BUY' ? cmd.sl > curSl : curSl === 0 || cmd.sl < curSl;
          if (better) {
            this.positionStates[ticket].currentSL = cmd.sl;
            this.pendingCommands.push({
              action: 'UPDATE_SL',
              ticket: cmd.ticket,
              sl: cmd.sl,
              reason: `live-observer:${cmd.reason}`,
            });
            tradingLogger.info(`Live observer SL adjust ${ticket}`, cmd.reason);
          }
        }

        // Guard: one bad position's trailing-stop calculation must never
        // abort processing of the rest of processMT5Update (see
        // trailingStopManager.ts guards for the empty-array root cause fix).
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

          // Persist the new phase so it survives a restart (crash recovery).
          try {
            await prisma.position.updateMany({
              where: { ticket },
              data: { trailingPhase: tsUpdate.phase },
            });
          } catch (persistError) {
            logger.error(`Failed to persist trailingPhase for ${ticket}`, persistError);
          }
        }
      } catch (error) {
        monitoring.trackError(`Trailing stop processing failed for ${ticket}: ${error}`, 'ERROR');
        logger.error(`Trailing stop processing failed for ${ticket}`, error);
      }
    }

    // Auto Trading + live setup scoreboard (always evaluated so Terminal can show progress)
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
      freeMargin: (payload as any).freeMargin,
      marginLevel: (payload as any).marginLevel,
      dailyLossPercent: (payload as any).dailyLossPercent,
      timezoneTradingEnabled: this.accountState.timezoneTradingEnabled,
      maxSpreadPoints: this.accountState.maxSpreadPoints,
    };

    const setupProgress = evaluateSetupProgress(signalPayload, {
      timezoneTradingEnabled: this.accountState.timezoneTradingEnabled,
      autoTradingEnabled: this.accountState.autoTradingEnabled,
    });
    this.accountState.setupProgress = setupProgress;
    this.accountState.lastSignalReason = setupProgress.summary;

    if (this.accountState.autoTradingEnabled) {
      const signal = validateSignal(
        signalPayload,
        features,
        this.latestRegime?.regime,
        this.latestRegime?.confidence ?? 0.6
      );
      const now = Date.now();
      if (signal && now - this.lastTradeTime > 30000 && now > this.cooldowns[signal.direction]) {
        // --- AI GATE — old + new side-by-side, shadow-safe ---
        // 1) Legacy confidence engine still runs first. Behavioral contract
        //    with `aiTradingEnabled` is preserved 100%.
        // 2) NEW: EnsembleDecisionEngine blends rule + FNN + CNN + LSTM.
        //    CNN/LSTM are absent for now → weights renormalize around rule +
        //    FNN bridge. Current production python weights (via the
        //    TradingPrediction object) count as the FNN voter immediately,
        //    so we get ensemble logging without waiting for new weights.
        // 3) Ensemble default: HARD GATE OFF. Any ensemble veto becomes
        //    SHADOW_REJECT, logged and SQL-saved, but NEVER stops a trade.
        //    Flipping (CONFIG as any).ensembleHardGate = true (opt-in, no
        //    env var exposed yet) enables real REJECTs from the ensemble.
        let aiPrediction: TradingPrediction | null = null;
        try {
          const vector = featureVector(features);
          aiPrediction = await modelManager.predictWithProduction(vector, signal.symbol);
        } catch (error) {
          tradingLogger.warn('AI prediction unavailable for this signal, proceeding rule-only', String(error));
        }

        // Legacy evaluation — behavioral contract with aiTradingEnabled preserved
        const evaluation = confidenceEngine.evaluate(
          { direction: signal.direction, confidence: signal.confidence },
          aiPrediction
        );
        tradingLogger.info(
          `Confidence evaluation [${evaluation.decision}] final=${(evaluation.finalConfidence * 100).toFixed(1)}%`,
          evaluation.reasons.join(' | ')
        );

        // --- NEW: Ensemble + Regime decision (Phase 1, additive) ---
        const riskScore = features.riskScore || 'MEDIUM';
        const tpDistancePips = signal.takeProfitLevels?.[0]
          ? Math.abs(signal.takeProfitLevels[0] - (signal.entryPrice || this.accountState.price)) / (this.accountState.pipSize || 0.01)
          : 0;
        const slDistancePips = signal.stopLoss
          ? Math.abs(signal.stopLoss - (signal.entryPrice || this.accountState.price)) / (this.accountState.pipSize || 0.01)
          : 1;
        const expectedRr = slDistancePips > 0 ? tpDistancePips / slDistancePips : CONFIG.tp1RR;
        const trendDir = features.trendDirection || 'NEUTRAL';

        let ensemble: EnsembleDecision | null = null;
        try {
          if (this.latestRegime) {
            ensemble = ensembleDecisionEngine.evaluate({
              symbol: signal.symbol,
              proposedDirection: signal.direction,
              ruleConfidence: evaluation.ruleConfidence,
              regime: this.latestRegime,
              trendDirection: trendDir,
              riskScore: riskScore as RiskScore,
              expectedRr,
              legacyTradingPrediction: aiPrediction,
              fnn: null,
              cnn: null,
              lstm: null,
              ruleReason: evaluation.reasons[0] || `Rule engine pass (${signal.confidence.toFixed(0)}/100)`,
              hardGate: !!(CONFIG as any).ensembleHardGate,
              minAgreeingModels: (CONFIG as any).ensembleMinAgreeingModels ?? 1,
            });
          }
        } catch (e) {
          monitoring.trackError(`Ensemble failed for signal: ${e}`, 'ERROR');
          ensemble = null;
        }

        try {
          if (ensemble) {
            this.latestEnsembleDecision = ensemble;
            void saveEnsemblePrediction({
              symbol: signal.symbol,
              proposedDirection: signal.direction,
              finalScore: ensemble.finalScore,
              decision: ensemble.decision,
              fnnVersion: ensemble.fnn?.version || (aiPrediction ? 'fnn-bridge' : undefined),
              cnnVersion: ensemble.cnn?.version,
              lstmVersion: ensemble.lstm?.version,
              fnnOutput: ensemble.fnn || (aiPrediction ? { bridged: true, ...aiPrediction } : null),
              cnnOutput: ensemble.cnn,
              lstmOutput: ensemble.lstm,
              ruleConfidence: ensemble.ruleConfidence,
              explainability: ensemble.explainability,
              regime: ensemble.regime.regime,
              regimeConfidence: ensemble.regime.confidence,
              weightsUsed: ensemble.weights,
              perModelScores: ensemble.perModelFinalScore,
              reasons: ensemble.reasons,
              hardGateEnabled: !!(CONFIG as any).ensembleHardGate,
            });
          }
        } catch (e) {
          monitoring.trackError(`EnsemblePrediction DB save failed: ${e}`, 'ERROR');
        }

        this.io.emit('aiConfidenceEvaluation', {
          signal,
          evaluation,
          ensemble,
          regime: this.latestRegime,
          aiTradingEnabled: CONFIG.aiTradingEnabled,
          ensembleHardGateEnabled: !!(CONFIG as any).ensembleHardGate,
        });

        // Final execution: legacy gate + optional ensemble HARD veto,
        // SHADOW_REJECT never blocks → zero behavior change by default.
        const legacyShouldExecute = !CONFIG.aiTradingEnabled || evaluation.decision === 'ACCEPT';
        const ensembleBlocks = !!(CONFIG as any).ensembleHardGate && ensemble?.decision === 'REJECT';
        const shouldExecute = legacyShouldExecute && !ensembleBlocks;

        if (!shouldExecute) {
          const why = !legacyShouldExecute ? 'AI confidence gate (aiTradingEnabled=true)' : `Ensemble hard-gate: ${ensemble?.regimeBlocked ? 'regime incompatible' : 'score below threshold'}`;
          tradingLogger.warn(`Signal rejected: ${why}`, signal.direction);
        } else {
          tradingLogger.success('New auto signal', signal.direction);
          if (ensemble?.decision === 'SHADOW_REJECT') {
            tradingLogger.info(`Note: ensemble SHADOW_REJECT (shadow-only, not blocking). ${ensemble.explainability.reason}`);
          }
          this.lastSignal = signal;
          // Enforce per-symbol trailing-profit re-entry limit if set.
          try {
            const sym = signal.symbol;
            const remaining = this.trailingProfitReentries?.[sym];
            if (typeof remaining === 'number') {
              if (remaining <= 0) {
                tradingLogger.warn(`Signal suppressed for ${sym}: trailing-profit re-entry limit reached`);
                // Still emit signal (shadow) for observability but don't send an order command.
                this.io.emit('tradeSignal', { ...signal, suppressedBy: 'TRAILING_REENTRY_LIMIT' });
                // record lastSignalConfidence for dashboard comparability
                this.lastTradeTime = now;
                this.lastSignalConfidence = {
                  direction: signal.direction,
                  finalConfidence: evaluation.finalConfidence,
                  aiConfidence: evaluation.aiConfidence,
                  modelVersion: modelManager.getProductionVersion(),
                  timestamp: now,
                  ensembleScore: ensemble?.finalScore,
                  marketRegime: this.latestRegime?.regime,
                  regimeConfidence: this.latestRegime?.confidence,
                  fnnConfidence: evaluation.aiConfidence,
                  cnnConfidence: ensemble?.perModelFinalScore.CNN ?? null,
                  lstmConfidence: ensemble?.perModelFinalScore.LSTM ?? null,
                  detectedPattern: ensemble?.explainability.patternDetected,
                  patternConfidence: ensemble?.cnn?.patternConfidence,
                  explainability: ensemble?.explainability ?? null,
                  ensembleDecision: ensemble?.decision,
                  fnnOutput: ensemble?.fnn || (aiPrediction ? { bridged: true, ...aiPrediction } : null),
                  cnnOutput: ensemble?.cnn || null,
                  lstmOutput: ensemble?.lstm || null,
                  ensembleOutput: ensemble || null,
                };
              } else {
                // Consume one allowance and execute
                this.trailingProfitReentries[sym] = Math.max(0, remaining - 1);
                tradingLogger.info(`Consuming 1 trailing re-entry for ${sym}; remaining=${this.trailingProfitReentries[sym]}`);
                this.pendingCommands.push({
                  action: signal.direction,
                  symbol: sym,
                  lots: signal.lotSizes.entry1,
                  sl: signal.stopLoss,
                  tp: signal.takeProfitLevels[0] || 0,
                });
                this.io.emit('tradeSignal', signal);
                this.lastTradeTime = now;
                this.lastSignalConfidence = {
                  direction: signal.direction,
                  finalConfidence: evaluation.finalConfidence,
                  aiConfidence: evaluation.aiConfidence,
                  modelVersion: modelManager.getProductionVersion(),
                  timestamp: now,
                  ensembleScore: ensemble?.finalScore,
                  marketRegime: this.latestRegime?.regime,
                  regimeConfidence: this.latestRegime?.confidence,
                  fnnConfidence: evaluation.aiConfidence,
                  cnnConfidence: ensemble?.perModelFinalScore.CNN ?? null,
                  lstmConfidence: ensemble?.perModelFinalScore.LSTM ?? null,
                  detectedPattern: ensemble?.explainability.patternDetected,
                  patternConfidence: ensemble?.cnn?.patternConfidence,
                  explainability: ensemble?.explainability ?? null,
                  ensembleDecision: ensemble?.decision,
                  fnnOutput: ensemble?.fnn || (aiPrediction ? { bridged: true, ...aiPrediction } : null),
                  cnnOutput: ensemble?.cnn || null,
                  lstmOutput: ensemble?.lstm || null,
                  ensembleOutput: ensemble || null,
                };
              }
            } else {
              // No limit set for this symbol — behave normally
              this.pendingCommands.push({
                action: signal.direction,
                symbol: signal.symbol,
                lots: signal.lotSizes.entry1,
                sl: signal.stopLoss,
                tp: signal.takeProfitLevels[0] || 0,
              });
              this.io.emit('tradeSignal', signal);
              this.lastTradeTime = now;
              this.lastSignalConfidence = {
                direction: signal.direction,
                finalConfidence: evaluation.finalConfidence,
                aiConfidence: evaluation.aiConfidence,
                modelVersion: modelManager.getProductionVersion(),
                timestamp: now,
                ensembleScore: ensemble?.finalScore,
                marketRegime: this.latestRegime?.regime,
                regimeConfidence: this.latestRegime?.confidence,
                fnnConfidence: evaluation.aiConfidence,
                cnnConfidence: ensemble?.perModelFinalScore.CNN ?? null,
                lstmConfidence: ensemble?.perModelFinalScore.LSTM ?? null,
                detectedPattern: ensemble?.explainability.patternDetected,
                patternConfidence: ensemble?.cnn?.patternConfidence,
                explainability: ensemble?.explainability ?? null,
                ensembleDecision: ensemble?.decision,
                fnnOutput: ensemble?.fnn || (aiPrediction ? { bridged: true, ...aiPrediction } : null),
                cnnOutput: ensemble?.cnn || null,
                lstmOutput: ensemble?.lstm || null,
                ensembleOutput: ensemble || null,
              };
            }
          } catch (e) {
            // Failsafe: if the guard code errors, fall back to original behavior
            tradingLogger.error(`Trailing re-entry guard failed: ${e}`);
            this.pendingCommands.push({
              action: signal.direction,
              symbol: signal.symbol,
              lots: signal.lotSizes.entry1,
              sl: signal.stopLoss,
              tp: signal.takeProfitLevels[0] || 0,
            });
            this.io.emit('tradeSignal', signal);
            this.lastTradeTime = now;
            this.lastSignalConfidence = {
              direction: signal.direction,
              finalConfidence: evaluation.finalConfidence,
              aiConfidence: evaluation.aiConfidence,
              modelVersion: modelManager.getProductionVersion(),
              timestamp: now,
              ensembleScore: ensemble?.finalScore,
              marketRegime: this.latestRegime?.regime,
              regimeConfidence: this.latestRegime?.confidence,
              fnnConfidence: evaluation.aiConfidence,
              cnnConfidence: ensemble?.perModelFinalScore.CNN ?? null,
              lstmConfidence: ensemble?.perModelFinalScore.LSTM ?? null,
              detectedPattern: ensemble?.explainability.patternDetected,
              patternConfidence: ensemble?.cnn?.patternConfidence,
              explainability: ensemble?.explainability ?? null,
              ensembleDecision: ensemble?.decision,
              fnnOutput: ensemble?.fnn || (aiPrediction ? { bridged: true, ...aiPrediction } : null),
              cnnOutput: ensemble?.cnn || null,
              lstmOutput: ensemble?.lstm || null,
              ensembleOutput: ensemble || null,
            };
          }
        }
      }
    }

    this.io.emit('EA_HEARTBEAT', {
      ...this.accountState,
      lastSignalReason: this.accountState.lastSignalReason || setupProgress.summary,
      setupProgress,
      timezoneTradingEnabled: this.accountState.timezoneTradingEnabled,
      autoTradingEnabled: this.accountState.autoTradingEnabled,
      regime: this.latestRegime,
      ensemble: this.latestEnsembleDecision
        ? {
            finalScore: this.latestEnsembleDecision.finalScore,
            decision: this.latestEnsembleDecision.decision,
            proposedDirection: this.latestEnsembleDecision.proposedDirection,
            weights: this.latestEnsembleDecision.weights,
            agreement: this.latestEnsembleDecision.agreement,
            explainability: this.latestEnsembleDecision.explainability,
            regime: this.latestEnsembleDecision.regime.regime,
            reasons: this.latestEnsembleDecision.reasons,
            timestamp: this.latestEnsembleDecision.timestamp,
            pattern: this.latestEnsembleDecision.explainability.patternDetected,
          }
        : null,
      training: {
        status: (modelManager as any).getTrainingStatus?.() || null,
        productionVersion: modelManager.getProductionVersion(),
        nextRetrainAt: (continuousLearning as any).nextScheduledTrainAt?.() || null,
      },
      server: {
        ts: Date.now(),
      },
    });
  }
}
