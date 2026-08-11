/**
 * seedSyntheticCandles.ts
 *
 * ONE-OFF DEV UTILITY — NOT part of the production pipeline.
 *
 * Generates synthetic, clearly-fake random-walk OHLC candles and stores them
 * via the real `saveCandle()` function, purely so the Simulation Engine has
 * something to replay against in a local dev environment with no real
 * market-data ingestion connected yet.
 *
 * This is NOT real market data and any simulation report produced from it
 * is NOT a measure of real strategy performance — it only proves the
 * pipeline (DB -> replay -> feature engineering -> signal validation ->
 * risk engine -> simulated broker -> DNA/experience/report) runs correctly
 * end-to-end.
 *
 * Usage: npx ts-node src/simulation/seedSyntheticCandles.ts [SYMBOL] [TIMEFRAME] [COUNT]
 */
import 'dotenv/config';
import { saveCandle } from '../database';

async function main() {
  const symbol = process.argv[2] || 'EURUSD';
  const timeframe = process.argv[3] || 'M5';
  const count = Number(process.argv[4] || 3000);

  console.log(`Seeding ${count} synthetic ${timeframe} candles for ${symbol} (dev/test only, not real market data)...`);

  let price = 1.085;
  const startTime = Date.now() - count * 5 * 60 * 1000; // M5 = 5 min apart
  const barMs = 5 * 60 * 1000;

  for (let i = 0; i < count; i++) {
    const drift = (Math.random() - 0.5) * 0.0008;
    const open = price;
    const close = Math.max(0.5, open + drift);
    const high = Math.max(open, close) + Math.random() * 0.0004;
    const low = Math.min(open, close) - Math.random() * 0.0004;
    const volume = 50 + Math.random() * 200;
    const timestamp = startTime + i * barMs;

    await saveCandle({ symbol, timeframe, open, high, low, close, volume, timestamp });
    price = close;

    if (i % 500 === 0) console.log(`  ...${i}/${count}`);
  }

  console.log('Done seeding synthetic candles.');
  process.exit(0);
}

main().catch((e) => {
  console.error('Seed failed:', e);
  process.exit(1);
});
