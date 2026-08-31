/**
 * TypeScript wrapper for the Python backtesting engine.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { appendAudit } from '../monitoring/audit';
import { logger } from '../logging';

export type BacktestStatus = 'IDLE' | 'RUNNING' | 'COMPLETED' | 'FAILED';

const PYTHON_DIR = path.join(__dirname, '../../python');
const PYTHON_PATH = process.env.PYTHON_PATH || 'python';
const DEFAULT_DATA = path.join(PYTHON_DIR, 'example_training_data.json');

/** Module-level status state, wired to `/api/backtest/status`. */
let status: BacktestStatus = 'IDLE';
let lastResult: any = null;
let lastArgs: any = null;
let startedAtMs: number | null = null;
let runningProc: any = null;
let stdoutTail = '';
let stderrTail = '';

export function getBacktestStatus() {
  const elapsedSec = status === 'RUNNING' && startedAtMs
    ? Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000))
    : 0;
  // Heuristic: 120s baseline for production backtests on Render CPU.
  const baselineSec = 180;
  const totalExpectedSec = baselineSec;
  let progressPct = 0;
  if (status === 'COMPLETED') progressPct = 1;
  else if (status === 'FAILED') progressPct = Math.min(0.99, elapsedSec / Math.max(totalExpectedSec, 60));
  else if (status === 'RUNNING') progressPct = Math.min(0.989, Math.max(0.02, elapsedSec / Math.max(totalExpectedSec, 30)));
  const remainingSec = status === 'RUNNING' ? Math.max(0, totalExpectedSec - elapsedSec) : 0;
  return {
    status,
    progress: { progressPct: Number(progressPct.toFixed(3)), elapsedSec, remainingSec },
    lastArgs,
    lastResult,
    stdoutTail,
    stderrTail,
  };
}

export function resetBacktest(reason: string = 'User requested reset') {
  try { if (runningProc && typeof runningProc.kill === 'function') runningProc.kill('SIGKILL'); } catch { /* ignore */ }
  runningProc = null;
  status = 'FAILED';
  lastResult = { success: false, error: reason, stdoutTail, stderrTail };
  appendAudit('BACKTEST', 'RESET', { reason });
  return { ok: true };
}

function runPython(args: string[], timeoutMs = 900000): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const proc = spawn(PYTHON_PATH, args, { cwd: PYTHON_DIR });
    runningProc = proc;
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      try { setTimeout(() => proc.kill('SIGKILL'), 5000); } catch { /* ignore */ }
      resolve({ stdout, stderr: stderr + '\nTIMEOUT', code: -1 });
    }, timeoutMs);

    const tail = () => { stdoutTail = stdout.slice(-2000); stderrTail = stderr.slice(-2000); };
    proc.stdout?.on('data', (d) => { stdout += d.toString(); tail(); });
    proc.stderr?.on('data', (d) => { stderr += d.toString(); tail(); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      tail();
      if (runningProc === proc) runningProc = null;
      resolve({ stdout, stderr, code });
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      stderr += `\nSPAWN_ERROR ${String(e)}`;
      tail();
      if (runningProc === proc) runningProc = null;
      resolve({ stdout, stderr, code: -2 });
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
  /**
   * Fire-and-forget async runner. Returns instantly so handler can 202.
   * Use getBacktestStatus() to poll for completion / view tails.
   */
  enqueue(options: { dataPath?: string; modelVersion?: string; deadlineMs?: number } = {}): { accepted: boolean; status: BacktestStatus; error?: string } {
    if (status === 'RUNNING') return { accepted: false, status, error: 'Backtest already in progress' };
    status = 'RUNNING';
    lastResult = null;
    stdoutTail = '';
    stderrTail = '';
    lastArgs = { ...options };
    startedAtMs = Date.now();
    const deadlineMs = Number(options.deadlineMs ?? process.env.BACKTEST_TIMEOUT_MS ?? 900_000);
    const self = this;
    setImmediate(() => {
      Promise.resolve()
        .then(() => self.run({ ...options }, deadlineMs))
        .then((r) => { status = r?.success ? 'COMPLETED' : 'FAILED'; lastResult = r; })
        .catch((e) => { status = 'FAILED'; lastResult = { success: false, error: String(e), stdoutTail, stderrTail }; });
    });
    return { accepted: true, status };
  }

  async run(options: {
    dataPath?: string;
    modelVersion?: string;
  } = {}, timeoutMs: number = 900_000): Promise<any> {
    const sourcePath = options.dataPath || DEFAULT_DATA;
    const dataPath = fs.existsSync(sourcePath) && fs.statSync(sourcePath).size <= 8 * 1024 * 1024
      ? sourcePath
      : DEFAULT_DATA;

    if (!fs.existsSync(dataPath)) {
      return { success: false, error: `Data file not found: ${dataPath}` };
    }

    appendAudit('BACKTEST', 'STARTED', { dataPath, modelVersion: options.modelVersion });

    const args = [path.join(PYTHON_DIR, 'backtest.py'), dataPath];
    if (options.modelVersion) args.push(options.modelVersion);

    const { stdout, stderr, code } = await runPython(args, timeoutMs);
    if (code !== 0) {
      const err = { success: false, error: stderr || stdout, stdoutTail, stderrTail };
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
      const err = { success: false, error: String(e), stdoutTail, stderrTail };
      appendAudit('BACKTEST', 'FAILED', err, options.modelVersion);
      return err;
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
