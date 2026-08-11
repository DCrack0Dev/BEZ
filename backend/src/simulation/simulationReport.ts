/**
 * simulationReport.ts
 *
 * Pure functions that compute performance statistics from a simulation's
 * trade log + equity curve. No trading logic lives here — just reporting.
 */

import { TradeLogEntry, EquityPoint } from './simulationEngine';

export interface MonthlyBreakdown {
  month: string; // YYYY-MM
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  netProfit: number;
}

export interface SimulationReport {
  totalTrades: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRate: number;
  lossRate: number;
  grossProfit: number;
  grossLoss: number;
  netProfit: number;
  profitFactor: number;
  sharpeRatio: number;
  sortinoRatio: number;
  maxDrawdownPercent: number;
  avgRealizedRR: number;
  avgHoldMinutes: number;
  tradesPerDay: number;
  startingBalance: number;
  endingBalance: number;
  endingEquity: number;
  totalReturnPercent: number;
  monthlyBreakdown: MonthlyBreakdown[];
  warning?: string;
}

const MIN_TRADES_FOR_SIGNIFICANCE = 30;

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function computeEquityReturns(equityCurve: EquityPoint[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].equity;
    const curr = equityCurve[i].equity;
    if (prev === 0) continue;
    returns.push((curr - prev) / prev);
  }
  return returns;
}

function computeMaxDrawdownPercent(equityCurve: EquityPoint[]): number {
  let peak = -Infinity;
  let maxDrawdown = 0;
  for (const point of equityCurve) {
    if (point.equity > peak) peak = point.equity;
    if (peak > 0) {
      const drawdown = (peak - point.equity) / peak;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }
  }
  return maxDrawdown * 100;
}

function computeMonthlyBreakdown(tradeLog: TradeLogEntry[]): MonthlyBreakdown[] {
  const byMonth = new Map<string, MonthlyBreakdown>();
  for (const trade of tradeLog) {
    const date = new Date(trade.closeTime);
    const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    let bucket = byMonth.get(month);
    if (!bucket) {
      bucket = { month, trades: 0, wins: 0, losses: 0, winRate: 0, netProfit: 0 };
      byMonth.set(month, bucket);
    }
    bucket.trades += 1;
    bucket.netProfit += trade.profit;
    if (trade.profit > 0) bucket.wins += 1;
    else if (trade.profit < 0) bucket.losses += 1;
  }
  const result = Array.from(byMonth.values());
  for (const bucket of result) {
    bucket.winRate = bucket.trades > 0 ? (bucket.wins / bucket.trades) * 100 : 0;
  }
  result.sort((a, b) => (a.month < b.month ? -1 : 1));
  return result;
}

export function generateSimulationReport(
  tradeLog: TradeLogEntry[],
  equityCurve: EquityPoint[],
  startingBalance: number
): SimulationReport {
  const totalTrades = tradeLog.length;
  const wins = tradeLog.filter((t) => t.profit > 0).length;
  const losses = tradeLog.filter((t) => t.profit < 0).length;
  const breakevens = totalTrades - wins - losses;

  const grossProfit = tradeLog.filter((t) => t.profit > 0).reduce((sum, t) => sum + t.profit, 0);
  const grossLoss = Math.abs(tradeLog.filter((t) => t.profit < 0).reduce((sum, t) => sum + t.profit, 0));
  const netProfit = tradeLog.reduce((sum, t) => sum + t.profit, 0);

  const equityReturns = computeEquityReturns(equityCurve);
  const meanReturn = mean(equityReturns);
  const stdReturn = stdDev(equityReturns);
  const downsideReturns = equityReturns.map((r) => (r < 0 ? r : 0));
  const downsideDeviation = Math.sqrt(mean(downsideReturns.map((r) => r * r)));

  const sharpeRatio = stdReturn > 0 ? meanReturn / stdReturn : 0;
  const sortinoRatio = downsideDeviation > 0 ? meanReturn / downsideDeviation : 0;

  const maxDrawdownPercent = computeMaxDrawdownPercent(equityCurve);

  const avgRealizedRR = mean(tradeLog.map((t) => t.realizedRR));
  const avgHoldMinutes = mean(tradeLog.map((t) => t.holdMinutes));

  const firstTs = equityCurve[0]?.timestamp;
  const lastTs = equityCurve[equityCurve.length - 1]?.timestamp;
  const totalDays = firstTs && lastTs && lastTs > firstTs ? (lastTs - firstTs) / (1000 * 60 * 60 * 24) : 0;
  const tradesPerDay = totalDays > 0 ? totalTrades / totalDays : 0;

  const endingBalance = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].balance : startingBalance;
  const endingEquity = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].equity : startingBalance;
  const totalReturnPercent = startingBalance > 0 ? ((endingBalance - startingBalance) / startingBalance) * 100 : 0;

  const report: SimulationReport = {
    totalTrades,
    wins,
    losses,
    breakevens,
    winRate: totalTrades > 0 ? (wins / totalTrades) * 100 : 0,
    lossRate: totalTrades > 0 ? (losses / totalTrades) * 100 : 0,
    grossProfit,
    grossLoss,
    netProfit,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    sharpeRatio,
    sortinoRatio,
    maxDrawdownPercent,
    avgRealizedRR,
    avgHoldMinutes,
    tradesPerDay,
    startingBalance,
    endingBalance,
    endingEquity,
    totalReturnPercent,
    monthlyBreakdown: computeMonthlyBreakdown(tradeLog),
  };

  if (totalTrades < MIN_TRADES_FOR_SIGNIFICANCE) {
    report.warning = `Only ${totalTrades} trade(s) were generated in this run — results are not statistically significant (recommended minimum: ${MIN_TRADES_FOR_SIGNIFICANCE}). Treat win rate, profit factor, Sharpe/Sortino, and drawdown figures as directional only.`;
  }

  return report;
}
