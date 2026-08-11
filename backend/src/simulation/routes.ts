// Lightweight API surface for the Trading Simulation Engine.
// Intended for smaller/quicker runs invoked synchronously; large backfills
// should use the CLI runner (runSimulation.ts) instead of this endpoint, as
// there is intentionally no async job queue in this first version.
import express from 'express';
import fs from 'fs';
import path from 'path';
import { SimulationEngine } from './simulationEngine';
import { generateSimulationReport } from './simulationReport';

const router = express.Router();
const SIMULATIONS_DIR = path.join(__dirname, '..', '..', 'data', 'simulations');

router.post('/run', async (req, res) => {
  try {
    const { symbol, timeframe, limit } = req.body || {};
    if (!symbol || !timeframe) {
      return res.status(400).json({ success: false, error: 'symbol and timeframe are required' });
    }

    const engine = new SimulationEngine({
      symbol,
      timeframe,
      candleLimit: limit ? Number(limit) : undefined,
    } as any);
    const result = await engine.run();

    if (result.candleCount === 0) {
      return res.status(404).json({ success: false, error: `No stored candles for ${symbol} ${timeframe}` });
    }

    const report = generateSimulationReport(result.tradeLog, result.equityCurve, result.config.initialBalance);

    fs.mkdirSync(SIMULATIONS_DIR, { recursive: true });
    const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const outputPath = path.join(SIMULATIONS_DIR, filename);
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

    res.json({ success: true, data: { report, config: result.config, savedAs: filename } });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

router.get('/history', (_req, res) => {
  try {
    if (!fs.existsSync(SIMULATIONS_DIR)) {
      return res.json({ success: true, data: [] });
    }
    const files = fs
      .readdirSync(SIMULATIONS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((name) => {
        const full = path.join(SIMULATIONS_DIR, name);
        const stat = fs.statSync(full);
        let summary: any = null;
        try {
          const parsed = JSON.parse(fs.readFileSync(full, 'utf-8'));
          summary = {
            symbol: parsed.config?.symbol,
            timeframe: parsed.config?.timeframe,
            totalTrades: parsed.report?.totalTrades,
            winRate: parsed.report?.winRate,
            netProfit: parsed.report?.netProfit,
          };
        } catch {
          // ignore malformed report files
        }
        return { name, mtime: stat.mtime.toISOString(), summary };
      })
      .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));

    res.json({ success: true, data: files });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

export const simulationRouter = router;
