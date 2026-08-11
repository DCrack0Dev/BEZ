/**
 * simulationEngine.ts
 *
 * Replays historical candles through the exact same decision-making
 * pipeline used live (feature-engineering -> signalValidator -> riskEngine
 * -> trailingStopManager -> analytics), with only the broker/execution
 * layer swapped out for `SimulationBroker`. No parallel trading logic is
 * implemented here — every entry/exit/risk decision is delegated to the
 * real modules, exactly as `trading-engine/index.ts` does for live trading.
 *
 * KNOWN GRANULARITY LIMITATION: `getCandles` returns OHLC candles, not raw
 * ticks (tick data isn't currently ingested/stored anywhere in this
 * codebase). This engine therefore replays at candle granularity — SL/TP
 * hits are detected against each candle's high/low rather than the true
 * intrabar tick path, and fills happen at a bar's open price rather than
 * mid-tick. True tick-level replay is out of scope for this first version
 * (see TODOs below).
 */

import { getCandles } from '../database';
import { Candle } from '../types';
import {
  validateSignal,
  calculateEMA,
  calculateATR,
  calculateSwingHighs,
  calculateSwingLows,
  MT5Payload,
} from '../trading-engine/signalValidator';
import { FeatureEngineeringEngine } from '../feature-engineering/featureEngine';
import { processTrailingStop, PositionState } from '../trade-execution/trailingStopManager';
import { TradeDnaEngine, TradeDNA } from '../analytics/tradeDna';
import { ExperienceEngine, Lesson } from '../analytics/experienceEngine';
import { SimulationBroker, SimBrokerConfig, SimClosedTrade } from './simulationBroker';
import { confidenceEngine } from '../confidence-engine';
import { modelManager } from '../model-management';
import { featureVector } from '../continuous-learning';
import { CONFIG } from '../config/tradingConfig';
import { TradingPrediction } from '../ai/tradingModel';

export interface SimulationConfig {
  symbol: string;
  timeframe: string;
  /** How many historical candles to pull via getCandles(). */
  candleLimit: number;
  /** Rolling window of candles fed to the signal pipeline each step (like the EA's "last N candles"). */
  rollingWindow: number;
  initialBalance: number;
  pipSize: number;
  pointSize: number;
  pipValue: number;
  minLot: number;
  maxLot: number;
  minLotStep: number;
  brokerConfig?: Partial<SimBrokerConfig>;
}

export const DEFAULT_SIMULATION_CONFIG: Omit<SimulationConfig, 'symbol' | 'timeframe'> = {
  candleLimit: 3000,
  rollingWindow: 100,
  initialBalance: 10000,
  pipSize: 0.0001,
  pointSize: 0.00001,
  pipValue: 10,
  minLot: 0.01,
  maxLot: 100,
  minLotStep: 0.01,
};

export interface TradeLogEntry {
  ticket: string;
  symbol: string;
  direction: 'BUY' | 'SELL';
  lots: number;
  entryPrice: number;
  exitPrice: number;
  sl: number;
  tp: number;
  openTime: number;
  closeTime: number;
  holdMinutes: number;
  profit: number;
  profitPips: number;
  commission: number;
  reason: SimClosedTrade['reason'];
  riskPercent: number;
  realizedRR: number;
  dna: TradeDNA | null;
  lessons: Lesson[];
}

export interface EquityPoint {
  barIndex: number;
  timestamp: number;
  balance: number;
  equity: number;
}

export interface SimulationResult {
  config: SimulationConfig;
  tradeLog: TradeLogEntry[];
  equityCurve: EquityPoint[];
  candleCount: number;
  simulatedFrom: number;
  simulatedTo: number;
}

interface PendingOrderMeta {
  signalId: string;
  riskPercent: number;
  features: any;
  /** Blended rule+AI confidence from ConfidenceEngine at signal time (0-1). */
  aiConfidence?: number;
}

export class SimulationEngine {
  private readonly config: SimulationConfig;
  private readonly featureEngine = new FeatureEngineeringEngine();
  private readonly dnaEngine = new TradeDnaEngine();
  private readonly experienceEngine = new ExperienceEngine();
  private readonly broker: SimulationBroker<PendingOrderMeta>;

  private positionStates: Record<string, PositionState> = {};
  private tradeLog: TradeLogEntry[] = [];
  private equityCurve: EquityPoint[] = [];

  constructor(config: Partial<SimulationConfig> & { symbol: string; timeframe: string }) {
    this.config = { ...DEFAULT_SIMULATION_CONFIG, ...config };
    this.broker = new SimulationBroker<PendingOrderMeta>({
      symbol: this.config.symbol,
      initialBalance: this.config.initialBalance,
      pipSize: this.config.pipSize,
      pointSize: this.config.pointSize,
      pipValue: this.config.pipValue,
      minLot: this.config.minLot,
      maxLot: this.config.maxLot,
      minLotStep: this.config.minLotStep,
      ...this.config.brokerConfig,
    });
  }

  /** Load candles via the existing (read-only) getCandles() and normalize to ascending chronological order with plain numbers. */
  private async loadCandles(): Promise<Candle[]> {
    const rows = await getCandles(this.config.symbol, this.config.timeframe, this.config.candleLimit);
    if (!rows || rows.length === 0) return [];

    const candles: Candle[] = rows.map((row: any) => ({
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
      timestamp: (row.timestamp instanceof Date ? row.timestamp : new Date(row.timestamp)).getTime(),
    }));

    // getCandles() orders by timestamp desc; the signal pipeline expects
    // chronological-ascending order (oldest first), matching signalValidator.ts.
    candles.reverse();
    return candles;
  }

  private handleOpen(ticket: string, position: ReturnType<SimulationBroker['getPositions']>[number], meta: PendingOrderMeta): void {
    const dna = this.dnaEngine.initializeTradeDNA(
      ticket,
      this.config.symbol,
      position.type,
      position.openPrice,
      position.sl,
      position.tp,
      position.volume,
      meta.riskPercent,
      meta.features,
      'sim-v1',
      meta.aiConfidence ?? 0.75
    );

    this.positionStates[ticket] = {
      ticket,
      signalId: meta.signalId,
      symbol: this.config.symbol,
      direction: position.type,
      openPrice: position.openPrice,
      currentSL: position.sl,
      currentPrice: position.openPrice,
      phase: 1,
      scaleInLevels: [],
      tpLevels: [position.tp].filter((v) => !!v),
      spread: this.broker.getCurrentSpread(),
      pipSize: this.config.pipSize,
      pointSize: this.config.pointSize,
    };

    void dna;
  }

  private handleClose(closed: SimClosedTrade, closeFeatures: any): void {
    const dna = this.dnaEngine.getDnaByTicket(closed.ticket);
    let finalizedDna: TradeDNA | null = null;
    let lessons: Lesson[] = [];

    if (dna) {
      lessons = this.experienceEngine.analyzeTrade(dna);
      const profitPercent = (closed.profit / this.config.initialBalance) * 100;
      finalizedDna = this.dnaEngine.finalizeTradeDNA(
        closed.ticket,
        closed.closePrice,
        closeFeatures,
        closed.profitPips,
        profitPercent,
        closed.profit,
        lessons.map((l) => l.title),
        lessons.map((l) => l.description)
      );
    }

    const riskDistance = Math.abs(closed.openPrice - closed.sl);
    const signedMove = closed.direction === 'BUY' ? closed.closePrice - closed.openPrice : closed.openPrice - closed.closePrice;
    const realizedRR = riskDistance > 0 ? signedMove / riskDistance : 0;

    this.tradeLog.push({
      ticket: closed.ticket,
      symbol: closed.symbol,
      direction: closed.direction,
      lots: closed.lots,
      entryPrice: closed.openPrice,
      exitPrice: closed.closePrice,
      sl: closed.sl,
      tp: closed.tp,
      openTime: closed.openTime,
      closeTime: closed.closeTime,
      holdMinutes: Math.max(0, Math.round((closed.closeTime - closed.openTime) / 60000)),
      profit: closed.profit,
      profitPips: closed.profitPips,
      commission: closed.commission,
      reason: closed.reason,
      riskPercent: finalizedDna?.riskPercent ?? 0,
      realizedRR,
      dna: finalizedDna,
      lessons,
    });

    delete this.positionStates[closed.ticket];
  }

  public async run(): Promise<SimulationResult> {
    const candles = await this.loadCandles();
    const window = this.config.rollingWindow;

    if (candles.length < window + 5) {
      return {
        config: this.config,
        tradeLog: [],
        equityCurve: [],
        candleCount: candles.length,
        simulatedFrom: candles[0]?.timestamp ?? 0,
        simulatedTo: candles[candles.length - 1]?.timestamp ?? 0,
      };
    }

    for (let i = window; i < candles.length; i++) {
      const currentBar = candles[i];
      // Rolling window INCLUDING the current (just-closed) bar, mirroring
      // how the live EA sends "last N candles" up to the latest closed candle.
      const rollingCandles = candles.slice(i - window + 1, i + 1);

      const ema20 = calculateEMA(rollingCandles, 20);
      const ema50 = calculateEMA(rollingCandles, 50);
      const ema20Prev = calculateEMA(rollingCandles.slice(0, -1), 20);
      const atr14 = calculateATR(rollingCandles, 14);
      const swingHighs = calculateSwingHighs(rollingCandles);
      const swingLows = calculateSwingLows(rollingCandles);
      const spread = this.broker.getCurrentSpread();

      const features = this.featureEngine.generateFeatures(
        this.config.symbol,
        this.config.timeframe,
        rollingCandles,
        ema20,
        ema50,
        atr14,
        spread,
        this.config.pipSize
      );

      // Advance the broker: fill due orders, check SL/TP against this bar's
      // range, mark to market, enforce stop-out.
      const barResult = this.broker.processBar(i, {
        open: currentBar.open,
        high: currentBar.high,
        low: currentBar.low,
        close: currentBar.close,
        timestamp: currentBar.timestamp,
      });

      for (const closed of barResult.closed) this.handleClose(closed, features);
      for (const { ticket, position, meta } of barResult.opened) this.handleOpen(ticket, position, meta);

      // Trailing stop management — identical call pattern to trading-engine/index.ts.
      const openPositions = this.broker.getPositions();
      for (const pos of openPositions) {
        const ticket = String(pos.ticket);
        const state = this.positionStates[ticket];
        if (!state) continue;
        state.currentPrice = pos.price;

        const tsUpdate = processTrailingStop(state);
        if (tsUpdate) {
          state.currentSL = tsUpdate.newSL;
          state.phase = tsUpdate.phase;
          this.broker.updateStopLoss(ticket, tsUpdate.newSL);
        }
      }

      // Build the MT5Payload-shaped object exactly like the live EA would,
      // using the broker's current account state/positions, then call the
      // real validateSignal() — no custom entry logic is written here.
      const account = this.broker.getAccountState();
      const payload: MT5Payload = {
        symbol: this.config.symbol,
        timeframe: this.config.timeframe,
        candles: rollingCandles,
        spread,
        balance: account.balance,
        equity: account.equity,
        pipSize: this.config.pipSize,
        pointSize: this.config.pointSize,
        pipValue: this.config.pipValue,
        minLot: this.config.minLot,
        maxLot: this.config.maxLot,
        minLotStep: this.config.minLotStep,
        swingHighs,
        swingLows,
        openPositionsCount: openPositions.length,
        ema20,
        ema20Prev,
        atr14,
        positions: openPositions,
        marginLevel: Number.isFinite(account.marginLevel) ? account.marginLevel : undefined,
      };

      // validateSignal() internally calls calculateRisk() (see
      // trading-engine/signalValidator.ts) and returns the full TradeSignal
      // already populated with lot size/SL/TP — calling calculateRisk() a
      // second time here would duplicate logic and diverge from live
      // behavior, so we reuse validateSignal's return directly, exactly as
      // trading-engine/index.ts does.
      const signal = validateSignal(payload);
      if (signal) {
        // Mirror trading-engine/index.ts's shadow-mode AI evaluation exactly:
        // the model always runs and is always logged (real PredictionLog
        // rows tagged with this simulation's synthetic/replay data), but it
        // only gates execution when CONFIG.aiTradingEnabled is true — so a
        // simulation run's behavior matches what live would actually do
        // under the same flag, rather than silently diverging.
        let aiPrediction: TradingPrediction | null = null;
        try {
          const vector = featureVector(features);
          aiPrediction = await modelManager.predictWithProduction(vector, signal.symbol);
        } catch {
          // AI unavailable during replay — degrade to rule-only, same as live.
        }
        const evaluation = confidenceEngine.evaluate(
          { direction: signal.direction, confidence: signal.confidence },
          aiPrediction
        );
        const shouldExecute = !CONFIG.aiTradingEnabled || evaluation.decision === 'ACCEPT';

        if (shouldExecute) {
          const meta: PendingOrderMeta = {
            signalId: signal.id,
            riskPercent: signal.riskPercent,
            features,
            aiConfidence: evaluation.finalConfidence,
          };
          this.broker.queueOrder(
            signal.direction,
            signal.lotSizes?.entry1 || this.config.minLot,
            signal.stopLoss,
            signal.takeProfitLevels?.[0] || 0,
            i,
            meta
          );
        }
      }

      this.equityCurve.push({
        barIndex: i,
        timestamp: currentBar.timestamp,
        balance: account.balance,
        equity: account.equity,
      });
    }

    return {
      config: this.config,
      tradeLog: this.tradeLog,
      equityCurve: this.equityCurve,
      candleCount: candles.length,
      simulatedFrom: candles[window]?.timestamp ?? 0,
      simulatedTo: candles[candles.length - 1]?.timestamp ?? 0,
    };
  }

  // --- Legitimate future enhancements (out of scope for this first version) ---
  // TODO: tick-level replay once tick data ingestion/storage exists (see database/index.ts saveTick).
  // TODO: Monte Carlo resampling of the trade log for confidence-interval estimates.
  // TODO: walk-forward analysis (rolling train/validate windows) rather than a single full-history pass.
}
