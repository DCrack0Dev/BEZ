/**
 * simulationBroker.ts
 *
 * A virtual broker used only by the Trading Simulation Engine. It never
 * touches HTTP or the database — it exists purely to stand in for the real
 * MT5/EA execution layer so that `SimulationEngine` can replay the exact same
 * decision-making code (signalValidator, riskEngine, trailing-stop manager)
 * against historical candles.
 *
 * Simplifications (documented, not hidden):
 *  - Fills happen at a configurable candle open price (default: the next
 *    bar's open), not at the exact signal-time price. This models
 *    execution latency without needing tick data.
 *  - Spread/slippage are modeled as simple price offsets, not a live
 *    order-book. `spreadPips`/`slippagePips` are expressed in "pip" price
 *    units (`pipSize`), matching how the rest of the codebase already
 *    treats spread (see signalValidator.ts's maxSpreadPips/maxSpreadPoints).
 *  - Margin/leverage uses a flat `contractSize` (units per 1.0 lot) rather
 *    than per-symbol contract specs pulled from a broker API.
 *  - Stop-loss/take-profit hits are detected against each candle's
 *    high/low (can't know intrabar sequencing without tick data — if both
 *    SL and TP are inside the same bar's range, SL is checked first as the
 *    conservative assumption).
 */

export interface SimBrokerConfig {
  symbol: string;
  initialBalance: number;
  pipSize: number;
  pointSize: number;
  pipValue: number; // $ profit per pip (or per point for XAU) per 1.0 lot
  minLot: number;
  maxLot: number;
  minLotStep: number;
  /** Spread expressed in pips (price units = spreadPips * pipSize). */
  spreadPips: number;
  /** Slippage magnitude expressed in pips, always applied against the trader. */
  slippagePips: number;
  slippageModel: 'fixed' | 'random';
  commissionPerLot: number;
  /** Number of bars after signal generation before the order fills (>=1). */
  executionDelayBars: number;
  leverage: number;
  /** Units of the underlying per 1.0 lot, used only for the margin model. */
  contractSize: number;
  /** Margin level percent (equity/usedMargin*100) below which a stop-out is forced. */
  stopOutLevel: number;
}

export const DEFAULT_BROKER_CONFIG: Omit<SimBrokerConfig, 'symbol' | 'initialBalance'> = {
  pipSize: 0.0001,
  pointSize: 0.00001,
  pipValue: 10,
  minLot: 0.01,
  maxLot: 100,
  minLotStep: 0.01,
  spreadPips: 1.5,
  slippagePips: 0.3,
  slippageModel: 'random',
  commissionPerLot: 7, // round-trip commission per 1.0 lot, in account currency
  executionDelayBars: 1,
  leverage: 100,
  contractSize: 100000,
  stopOutLevel: 50,
};

export interface SimPosition {
  ticket: string;
  symbol: string;
  direction: 'BUY' | 'SELL';
  lots: number;
  openPrice: number;
  sl: number;
  tp: number;
  openBarIndex: number;
  openTime: number;
  currentPrice: number;
  floatingPL: number;
  commission: number;
}

export interface SimClosedTrade {
  ticket: string;
  symbol: string;
  direction: 'BUY' | 'SELL';
  lots: number;
  openPrice: number;
  closePrice: number;
  sl: number;
  tp: number;
  openBarIndex: number;
  closeBarIndex: number;
  openTime: number;
  closeTime: number;
  profit: number;
  profitPips: number;
  commission: number;
  reason: 'SL' | 'TP' | 'STOPOUT' | 'MANUAL';
}

export interface PendingOrder<TMeta = unknown> {
  direction: 'BUY' | 'SELL';
  lots: number;
  sl: number;
  tp: number;
  queuedAtBarIndex: number;
  executeAtBarIndex: number;
  meta: TMeta;
}

export interface SimCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  timestamp: number;
}

export interface BarProcessResult<TMeta = unknown> {
  opened: { ticket: string; position: SimPosition; meta: TMeta }[];
  closed: SimClosedTrade[];
}

export interface BrokerAccountState {
  balance: number;
  equity: number;
  usedMargin: number;
  freeMargin: number;
  marginLevel: number; // percent; Infinity when no open positions
}

export class SimulationBroker<TMeta = unknown> {
  private balance: number;
  private equity: number;
  private positions: Map<string, SimPosition> = new Map();
  private pendingOrders: PendingOrder<TMeta>[] = [];
  private closedTrades: SimClosedTrade[] = [];
  private ticketCounter = 1;
  private readonly config: SimBrokerConfig;

  constructor(config: Partial<SimBrokerConfig> & { symbol: string; initialBalance: number }) {
    this.config = { ...DEFAULT_BROKER_CONFIG, ...config };
    this.balance = this.config.initialBalance;
    this.equity = this.config.initialBalance;
  }

  private isXAU(): boolean {
    return this.config.symbol.includes('XAU') || this.config.symbol.includes('GOLD');
  }

  private getSlippagePrice(): number {
    const magnitude = this.config.slippagePips * this.config.pipSize;
    if (this.config.slippageModel === 'random') {
      return Math.random() * magnitude;
    }
    return magnitude;
  }

  private getSpreadPrice(): number {
    return this.config.spreadPips * this.config.pipSize;
  }

  /** Current effective spread in price units, exposed for building MT5Payload.spread. */
  public getCurrentSpread(): number {
    return this.getSpreadPrice();
  }

  private computeFillPrice(direction: 'BUY' | 'SELL', barOpen: number): number {
    const slip = this.getSlippagePrice();
    const spread = this.getSpreadPrice();
    // BUY fills at "ask" (worse price); SELL fills at "bid". Slippage always
    // moves the fill further against the trader, never in their favor.
    return direction === 'BUY' ? barOpen + spread + slip : barOpen - slip;
  }

  private calcGrossProfit(pos: SimPosition, atPrice: number): number {
    const unit = this.isXAU() ? this.config.pointSize : this.config.pipSize;
    const priceDiff = pos.direction === 'BUY' ? atPrice - pos.openPrice : pos.openPrice - atPrice;
    const units = priceDiff / unit;
    return units * this.config.pipValue * pos.lots;
  }

  private calcProfitPips(pos: SimPosition, atPrice: number): number {
    const unit = this.isXAU() ? this.config.pointSize : this.config.pipSize;
    const priceDiff = pos.direction === 'BUY' ? atPrice - pos.openPrice : pos.openPrice - atPrice;
    return priceDiff / unit;
  }

  private getUsedMargin(): number {
    let used = 0;
    for (const pos of this.positions.values()) {
      used += (pos.lots * this.config.contractSize * pos.openPrice) / this.config.leverage;
    }
    return used;
  }

  /** Queue a new order to fill after `executionDelayBars` bars (realistic latency, not instant fill). */
  public queueOrder(
    direction: 'BUY' | 'SELL',
    lots: number,
    sl: number,
    tp: number,
    currentBarIndex: number,
    meta: TMeta
  ): void {
    const clampedLots = Math.max(this.config.minLot, Math.min(this.config.maxLot, lots));
    this.pendingOrders.push({
      direction,
      lots: clampedLots,
      sl,
      tp,
      queuedAtBarIndex: currentBarIndex,
      executeAtBarIndex: currentBarIndex + Math.max(1, this.config.executionDelayBars),
      meta,
    });
  }

  /** Move a position's stop loss (used to apply trailing-stop updates). Never validated against direction here — caller (trailingStopManager) already enforces the idempotent-only-in-profit rule. */
  public updateStopLoss(ticket: string, newSL: number): boolean {
    const pos = this.positions.get(ticket);
    if (!pos) return false;
    pos.sl = newSL;
    return true;
  }

  public getOpenPosition(ticket: string): SimPosition | undefined {
    return this.positions.get(ticket);
  }

  private closePositionInternal(
    ticket: string,
    price: number,
    reason: SimClosedTrade['reason'],
    barIndex: number,
    time: number
  ): SimClosedTrade | null {
    const pos = this.positions.get(ticket);
    if (!pos) return null;
    const grossProfit = this.calcGrossProfit(pos, price);
    const netProfit = grossProfit - pos.commission;
    this.balance += netProfit;
    this.positions.delete(ticket);

    const record: SimClosedTrade = {
      ticket,
      symbol: pos.symbol,
      direction: pos.direction,
      lots: pos.lots,
      openPrice: pos.openPrice,
      closePrice: price,
      sl: pos.sl,
      tp: pos.tp,
      openBarIndex: pos.openBarIndex,
      closeBarIndex: barIndex,
      openTime: pos.openTime,
      closeTime: time,
      profit: netProfit,
      profitPips: this.calcProfitPips(pos, price),
      commission: pos.commission,
      reason,
    };
    this.closedTrades.push(record);
    return record;
  }

  /**
   * Advance the broker by one bar: fill any pending orders due this bar,
   * check open positions for SL/TP hits against this bar's range, mark to
   * market, and enforce a stop-out if margin level breaches stopOutLevel.
   */
  public processBar(barIndex: number, candle: SimCandle): BarProcessResult<TMeta> {
    const opened: BarProcessResult<TMeta>['opened'] = [];
    const closed: SimClosedTrade[] = [];

    // 1. Fill due pending orders at this bar's open (+ spread/slippage).
    const due = this.pendingOrders.filter((o) => o.executeAtBarIndex === barIndex);
    this.pendingOrders = this.pendingOrders.filter((o) => o.executeAtBarIndex !== barIndex);

    for (const order of due) {
      const fillPrice = this.computeFillPrice(order.direction, candle.open);
      const ticket = `SIM-${this.ticketCounter++}`;
      const commission = this.config.commissionPerLot * order.lots;
      const position: SimPosition = {
        ticket,
        symbol: this.config.symbol,
        direction: order.direction,
        lots: order.lots,
        openPrice: fillPrice,
        sl: order.sl,
        tp: order.tp,
        openBarIndex: barIndex,
        openTime: candle.timestamp,
        currentPrice: fillPrice,
        floatingPL: 0,
        commission,
      };
      this.positions.set(ticket, position);
      opened.push({ ticket, position, meta: order.meta });
    }

    // 2. Check SL/TP hits for all open positions against this bar's range.
    // Conservative assumption: if both SL and TP fall within the same bar's
    // high/low, SL is treated as hit first (can't be verified without ticks).
    for (const pos of Array.from(this.positions.values())) {
      let hitPrice: number | null = null;
      let reason: SimClosedTrade['reason'] | null = null;

      if (pos.direction === 'BUY') {
        if (pos.sl > 0 && candle.low <= pos.sl) {
          hitPrice = pos.sl;
          reason = 'SL';
        } else if (pos.tp > 0 && candle.high >= pos.tp) {
          hitPrice = pos.tp;
          reason = 'TP';
        }
      } else {
        if (pos.sl > 0 && candle.high >= pos.sl) {
          hitPrice = pos.sl;
          reason = 'SL';
        } else if (pos.tp > 0 && candle.low <= pos.tp) {
          hitPrice = pos.tp;
          reason = 'TP';
        }
      }

      if (hitPrice !== null && reason !== null) {
        const rec = this.closePositionInternal(pos.ticket, hitPrice, reason, barIndex, candle.timestamp);
        if (rec) closed.push(rec);
      }
    }

    // 3. Mark remaining open positions to market using this bar's close.
    for (const pos of this.positions.values()) {
      pos.currentPrice = candle.close;
      pos.floatingPL = this.calcGrossProfit(pos, candle.close);
    }
    this.recomputeEquity();

    // 4. Stop-out: force-close the largest losing position until margin
    // level recovers above stopOutLevel (or no positions remain).
    while (this.positions.size > 0) {
      const usedMargin = this.getUsedMargin();
      if (usedMargin <= 0) break;
      const marginLevel = (this.equity / usedMargin) * 100;
      if (marginLevel >= this.config.stopOutLevel) break;

      let worst: SimPosition | null = null;
      for (const p of this.positions.values()) {
        if (!worst || p.floatingPL < worst.floatingPL) worst = p;
      }
      if (!worst) break;

      const rec = this.closePositionInternal(worst.ticket, candle.close, 'STOPOUT', barIndex, candle.timestamp);
      if (rec) closed.push(rec);
      this.recomputeEquity();
    }

    return { opened, closed };
  }

  private recomputeEquity(): void {
    let floating = 0;
    for (const pos of this.positions.values()) floating += pos.floatingPL;
    this.equity = this.balance + floating;
  }

  public getAccountState(): BrokerAccountState {
    const usedMargin = this.getUsedMargin();
    return {
      balance: this.balance,
      equity: this.equity,
      usedMargin,
      freeMargin: this.equity - usedMargin,
      marginLevel: usedMargin > 0 ? (this.equity / usedMargin) * 100 : Infinity,
    };
  }

  /**
   * Positions shaped the way live MT5Payload/AccountState.positions expects
   * elsewhere in the codebase (see trading-engine/index.ts's usage of
   * pos.ticket/pos.type/pos.openPrice/pos.sl/pos.tp/pos.volume), so this can
   * be fed straight into validateSignal/riskEngine like a real EA payload.
   */
  public getPositions(): any[] {
    return Array.from(this.positions.values()).map((pos) => ({
      ticket: pos.ticket,
      symbol: pos.symbol,
      type: pos.direction,
      openPrice: pos.openPrice,
      price: pos.currentPrice,
      sl: pos.sl,
      tp: pos.tp,
      volume: pos.lots,
      lots: pos.lots,
      profit: pos.floatingPL,
    }));
  }

  public getClosedTrades(): SimClosedTrade[] {
    return [...this.closedTrades];
  }

  public getConfig(): SimBrokerConfig {
    return { ...this.config };
  }
}
