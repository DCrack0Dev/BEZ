/**
 * TypeScript wrapper for the Python backtesting engine.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { appendAudit } from '../monitoring/audit';
import { logger } from '../logging';

const PYTHON_DIR = path.join(__dirname, '../../python');
const PYTHON_PATH = process.env.PYTHON_PATH || 'python';
const DEFAULT_DATA = path.join(PYTHON_DIR, 'example_training_data.json');

function runPython(args: string[], timeoutMs = 300000): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const proc = spawn(PYTHON_PATH, args, { cwd: PYTHON_DIR });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      resolve({ stdout, stderr: stderr + '\nTIMEOUT', code: -1 });
    }, timeoutMs);
    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}

function parseLastJson(output: string): any {
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // continue
    }
  }
  throw new Error(`No JSON in backtest output: ${output.slice(-400)}`);
}

export class BacktestEngine {
  async run(options: {
    dataPath?: string;
    modelVersion?: string;
  } = {}): Promise<any> {
    const dataPath = options.dataPath || DEFAULT_DATA;
    if (!fs.existsSync(dataPath)) {
      return { success: false, error: `Data file not found: ${dataPath}` };
    }

    appendAudit('BACKTEST', 'STARTED', { dataPath, modelVersion: options.modelVersion });

    const args = [path.join(PYTHON_DIR, 'backtest.py'), dataPath];
    if (options.modelVersion) args.push(options.modelVersion);

    const { stdout, stderr, code } = await runPython(args);
    if (code !== 0) {
      const err = { success: false, error: stderr || stdout };
      appendAudit('BACKTEST', 'FAILED', err, options.modelVersion);
      logger.error('Backtest failed', err);
      return err;
    }

    try {
      const result = parseLastJson(stdout);
      appendAudit(
        'BACKTEST',
        'COMPLETED',
        {
          win_rate: result.win_rate,
          profit_factor: result.profit_factor,
          sharpe_ratio: result.sharpe_ratio,
          max_drawdown: result.max_drawdown,
          n_trades: result.n_trades,
          report_paths: result.report_paths,
        },
        result.model_version
      );
      return result;
    } catch (e) {
      appendAudit('BACKTEST', 'FAILED', { error: String(e) }, options.modelVersion);
      return { success: false, error: String(e) };
    }
  }

  listReports(): { name: string; path: string; mtime: string }[] {
    const reportsDir = path.join(PYTHON_DIR, 'reports');
    if (!fs.existsSync(reportsDir)) return [];
    return fs
      .readdirSync(reportsDir)
      .filter((f) => f.endsWith('.json'))
      .map((name) => {
        const full = path.join(reportsDir, name);
        const st = fs.statSync(full);
        return { name, path: full, mtime: st.mtime.toISOString() };
      })
      .sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  }

  readReport(name: string): any {
    const full = path.join(PYTHON_DIR, 'reports', path.basename(name));
    if (!fs.existsSync(full)) throw new Error('Report not found');
    return JSON.parse(fs.readFileSync(full, 'utf-8'));
  }
}

export const backtestEngine = new BacktestEngine();
