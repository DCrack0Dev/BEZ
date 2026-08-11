/**
 * runSimulation.ts
 *
 * Standalone CLI entry point for the Trading Simulation Engine.
 *
 * Usage:
 *   npx ts-node src/simulation/runSimulation.ts [SYMBOL] [TIMEFRAME] [LIMIT]
 *   npm run simulate -- EURUSD M5 3000
 *
 * If no args are given, the DEFAULTS below are used — edit them directly if
 * you'd rather not pass CLI args.
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { SimulationEngine } from './simulationEngine';
import { generateSimulationReport } from './simulationReport';

// --- Defaults (override via CLI args: symbol timeframe limit) ---
const DEFAULTS = {
  symbol: 'EURUSD',
  timeframe: 'M5',
  limit: 3000,
};

function formatCurrency(n: number): string {
  return `$${n.toFixed(2)}`;
}

async function main() {
  const [argSymbol, argTimeframe, argLimit] = process.argv.slice(2);
  const symbol = argSymbol || DEFAULTS.symbol;
  const timeframe = argTimeframe || DEFAULTS.timeframe;
  const candleLimit = argLimit ? parseInt(argLimit, 10) : DEFAULTS.limit;

  console.log(`\n=== LiquiBot Trading Simulation ===`);
  console.log(`Symbol: ${symbol} | Timeframe: ${timeframe} | Candle limit: ${candleLimit}\n`);

  const engine = new SimulationEngine({ symbol, timeframe, candleLimit });
  const result = await engine.run();

  if (result.candleCount === 0) {
    console.error('No candles were returned by getCandles() — check DATABASE_URL / that this symbol+timeframe has stored candles.');
    process.exitCode = 1;
    return;
  }

  const report = generateSimulationReport(result.tradeLog, result.equityCurve, result.config.initialBalance);

  console.log('--- Summary ---');
  console.log(`Candles replayed: ${result.candleCount}`);
  console.log(`Period: ${new Date(result.simulatedFrom).toISOString()} -> ${new Date(result.simulatedTo).toISOString()}`);
  console.log(`Total trades: ${report.totalTrades}`);
  console.log(`Win rate: ${report.winRate.toFixed(1)}% | Loss rate: ${report.lossRate.toFixed(1)}%`);
  console.log(`Profit factor: ${report.profitFactor.toFixed(2)}`);
  console.log(`Sharpe: ${report.sharpeRatio.toFixed(3)} | Sortino: ${report.sortinoRatio.toFixed(3)}`);
  console.log(`Max drawdown: ${report.maxDrawdownPercent.toFixed(2)}%`);
  console.log(`Avg realized R:R: ${report.avgRealizedRR.toFixed(2)} | Avg hold: ${report.avgHoldMinutes.toFixed(1)} min`);
  console.log(`Trades/day: ${report.tradesPerDay.toFixed(2)}`);
  console.log(`Starting balance: ${formatCurrency(report.startingBalance)}`);
  console.log(`Ending balance: ${formatCurrency(report.endingBalance)} (${report.totalReturnPercent.toFixed(2)}%)`);
  console.log(`Ending equity: ${formatCurrency(report.endingEquity)}`);
  if (report.warning) console.log(`\n⚠️  ${report.warning}`);

  if (report.monthlyBreakdown.length > 0) {
    console.log('\n--- Monthly Breakdown ---');
    for (const m of report.monthlyBreakdown) {
      console.log(`${m.month}: ${m.trades} trades, ${m.winRate.toFixed(1)}% WR, net ${formatCurrency(m.netProfit)}`);
    }
  }

  const outputDir = path.join(__dirname, '..', '..', 'data', 'simulations');
  fs.mkdirSync(outputDir, { recursive: true });
  const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const outputPath = path.join(outputDir, filename);

  fs.writeFileSync(
    outputPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        config: result.config,
        report,
        tradeLog: result.tradeLog,
        equityCurve: result.equityCurve,
      },
      null,
      2
    )
  );

  console.log(`\nFull report + trade log written to: ${outputPath}\n`);
}

main().catch((error) => {
  console.error('Simulation run failed:', error);
  process.exitCode = 1;
});
