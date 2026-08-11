/**
 * System monitoring — latency, resources, errors, broker responses, alerts.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { Request, Response, NextFunction } from 'express';
import { logger } from '../logging';

const DATA_DIR = path.join(__dirname, '../../data/monitoring');
const ALERTS_PATH = path.join(DATA_DIR, 'alerts.json');
const SNAPSHOT_PATH = path.join(DATA_DIR, 'snapshot.json');

export type AlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL';
export type AlertCategory =
  | 'API'
  | 'INFERENCE'
  | 'EXECUTION'
  | 'DATABASE'
  | 'SYSTEM'
  | 'BROKER'
  | 'ERROR';

export interface Alert {
  id: string;
  severity: AlertSeverity;
  category: AlertCategory;
  metric: string;
  value: number;
  threshold: number;
  message: string;
  acknowledged: boolean;
  createdAt: string;
}

interface LatencyBucket {
  count: number;
  sumMs: number;
  maxMs: number;
  recent: number[]; // last N samples
}

interface BrokerResponseStat {
  count: number;
  success: number;
  fail: number;
  lastCode?: string | number;
  lastLatencyMs?: number;
  lastAt?: string;
}

const THRESHOLDS = {
  apiLatencyMs: Number(process.env.ALERT_API_LATENCY_MS || 1500),
  inferenceLatencyMs: Number(process.env.ALERT_INFERENCE_LATENCY_MS || 2000),
  executionLatencyMs: Number(process.env.ALERT_EXECUTION_LATENCY_MS || 3000),
  dbLatencyMs: Number(process.env.ALERT_DB_LATENCY_MS || 1000),
  cpuPercent: Number(process.env.ALERT_CPU_PERCENT || 85),
  ramPercent: Number(process.env.ALERT_RAM_PERCENT || 90),
  errorRatePerMin: Number(process.env.ALERT_ERROR_RATE || 10),
  brokerFailRate: Number(process.env.ALERT_BROKER_FAIL_RATE || 0.25),
};

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function newBucket(): LatencyBucket {
  return { count: 0, sumMs: 0, maxMs: 0, recent: [] };
}

function recordLatency(bucket: LatencyBucket, ms: number) {
  bucket.count += 1;
  bucket.sumMs += ms;
  bucket.maxMs = Math.max(bucket.maxMs, ms);
  bucket.recent.push(ms);
  if (bucket.recent.length > 200) bucket.recent.shift();
}

function avg(bucket: LatencyBucket): number {
  return bucket.count ? bucket.sumMs / bucket.count : 0;
}

function p95(bucket: LatencyBucket): number {
  if (!bucket.recent.length) return 0;
  const sorted = [...bucket.recent].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[idx];
}

class MonitoringService {
  private api = newBucket();
  private inference = newBucket();
  private execution = newBucket();
  private database = newBucket();
  private errors: { at: string; message: string; category: string }[] = [];
  private failures: { at: string; message: string; category: string }[] = [];
  private broker: BrokerResponseStat = { count: 0, success: 0, fail: 0 };
  private alerts: Alert[] = [];
  private cpuBaseline = os.cpus().map((c) => c.times);
  private startedAt = Date.now();

  constructor() {
    ensureDir();
    this.loadAlerts();
    // Sample system resources every 15s
    setInterval(() => this.sampleSystem(), 15000).unref?.();
  }

  private loadAlerts() {
    try {
      if (fs.existsSync(ALERTS_PATH)) {
        this.alerts = JSON.parse(fs.readFileSync(ALERTS_PATH, 'utf-8'));
      }
    } catch {
      this.alerts = [];
    }
  }

  private persistAlerts() {
    ensureDir();
    fs.writeFileSync(ALERTS_PATH, JSON.stringify(this.alerts.slice(-500), null, 2));
  }

  private persistSnapshot(snapshot: any) {
    ensureDir();
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
  }

  private raiseAlert(
    severity: AlertSeverity,
    category: AlertCategory,
    metric: string,
    value: number,
    threshold: number,
    message: string
  ) {
    // Deduplicate same metric within 2 minutes
    const recent = this.alerts.find(
      (a) =>
        a.metric === metric &&
        !a.acknowledged &&
        Date.now() - new Date(a.createdAt).getTime() < 120000
    );
    if (recent) return;

    const alert: Alert = {
      id: `alert_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      severity,
      category,
      metric,
      value,
      threshold,
      message,
      acknowledged: false,
      createdAt: new Date().toISOString(),
    };
    this.alerts.push(alert);
    this.persistAlerts();
    logger.warn(`[ALERT ${severity}] ${message}`, { metric, value, threshold });
  }

  private checkLatency(
    category: AlertCategory,
    metric: string,
    ms: number,
    threshold: number
  ) {
    if (ms > threshold) {
      this.raiseAlert(
        ms > threshold * 2 ? 'CRITICAL' : 'WARNING',
        category,
        metric,
        ms,
        threshold,
        `${metric} ${ms.toFixed(0)}ms exceeded threshold ${threshold}ms`
      );
    }
  }

  trackApiLatency(ms: number, route?: string) {
    recordLatency(this.api, ms);
    this.checkLatency('API', 'api_latency_ms', ms, THRESHOLDS.apiLatencyMs);
    if (route && ms > THRESHOLDS.apiLatencyMs) {
      logger.warn(`Slow API ${route}: ${ms.toFixed(0)}ms`);
    }
  }

  trackInferenceLatency(ms: number) {
    recordLatency(this.inference, ms);
    this.checkLatency('INFERENCE', 'inference_latency_ms', ms, THRESHOLDS.inferenceLatencyMs);
  }

  trackExecutionLatency(ms: number) {
    recordLatency(this.execution, ms);
    this.checkLatency('EXECUTION', 'execution_latency_ms', ms, THRESHOLDS.executionLatencyMs);
  }

  trackDbLatency(ms: number, op?: string) {
    recordLatency(this.database, ms);
    this.checkLatency('DATABASE', 'db_latency_ms', ms, THRESHOLDS.dbLatencyMs);
    if (op && ms > THRESHOLDS.dbLatencyMs) {
      logger.warn(`Slow DB ${op}: ${ms.toFixed(0)}ms`);
    }
  }

  trackError(message: string, category: AlertCategory = 'ERROR') {
    this.errors.push({ at: new Date().toISOString(), message, category });
    if (this.errors.length > 500) this.errors.shift();
    this.raiseAlert('WARNING', category, 'error', 1, 0, message);
    this.checkErrorRate();
  }

  trackFailure(message: string, category: AlertCategory = 'ERROR') {
    this.failures.push({ at: new Date().toISOString(), message, category });
    if (this.failures.length > 500) this.failures.shift();
    this.raiseAlert('CRITICAL', category, 'failure', 1, 0, message);
  }

  trackBrokerResponse(ok: boolean, latencyMs?: number, code?: string | number) {
    this.broker.count += 1;
    if (ok) this.broker.success += 1;
    else this.broker.fail += 1;
    this.broker.lastCode = code;
    this.broker.lastLatencyMs = latencyMs;
    this.broker.lastAt = new Date().toISOString();
    if (latencyMs != null) {
      this.trackExecutionLatency(latencyMs);
    }
    const failRate = this.broker.count ? this.broker.fail / this.broker.count : 0;
    if (this.broker.count >= 10 && failRate >= THRESHOLDS.brokerFailRate) {
      this.raiseAlert(
        'CRITICAL',
        'BROKER',
        'broker_fail_rate',
        failRate,
        THRESHOLDS.brokerFailRate,
        `Broker fail rate ${(failRate * 100).toFixed(1)}% exceeds ${(THRESHOLDS.brokerFailRate * 100).toFixed(0)}%`
      );
    }
    if (!ok) {
      this.trackFailure(`Broker response failed (code=${code})`, 'BROKER');
    }
  }

  private checkErrorRate() {
    const oneMinAgo = Date.now() - 60000;
    const recent = this.errors.filter((e) => new Date(e.at).getTime() >= oneMinAgo).length;
    if (recent >= THRESHOLDS.errorRatePerMin) {
      this.raiseAlert(
        'CRITICAL',
        'ERROR',
        'error_rate_per_min',
        recent,
        THRESHOLDS.errorRatePerMin,
        `${recent} errors in the last minute`
      );
    }
  }

  private cpuPercent(): number {
    const cpus = os.cpus();
    let idleDiff = 0;
    let totalDiff = 0;
    cpus.forEach((cpu, i) => {
      const prev = this.cpuBaseline[i] || cpu.times;
      const idle = cpu.times.idle - prev.idle;
      const total =
        Object.values(cpu.times).reduce((a, b) => a + b, 0) -
        Object.values(prev).reduce((a, b) => a + b, 0);
      idleDiff += idle;
      totalDiff += total;
    });
    this.cpuBaseline = cpus.map((c) => c.times);
    if (totalDiff <= 0) return 0;
    return Math.max(0, Math.min(100, (1 - idleDiff / totalDiff) * 100));
  }

  private ramPercent(): number {
    const total = os.totalmem();
    const free = os.freemem();
    return total ? ((total - free) / total) * 100 : 0;
  }

  sampleSystem() {
    const cpu = this.cpuPercent();
    const ram = this.ramPercent();
    if (cpu >= THRESHOLDS.cpuPercent) {
      this.raiseAlert(
        cpu >= 95 ? 'CRITICAL' : 'WARNING',
        'SYSTEM',
        'cpu_percent',
        cpu,
        THRESHOLDS.cpuPercent,
        `CPU ${cpu.toFixed(1)}% exceeds ${THRESHOLDS.cpuPercent}%`
      );
    }
    if (ram >= THRESHOLDS.ramPercent) {
      this.raiseAlert(
        ram >= 95 ? 'CRITICAL' : 'WARNING',
        'SYSTEM',
        'ram_percent',
        ram,
        THRESHOLDS.ramPercent,
        `RAM ${ram.toFixed(1)}% exceeds ${THRESHOLDS.ramPercent}%`
      );
    }
    this.persistSnapshot(this.getSnapshot());
  }

  async timeAsync<T>(
    kind: 'api' | 'inference' | 'execution' | 'database',
    fn: () => Promise<T>,
    label?: string
  ): Promise<T> {
    const start = Date.now();
    try {
      const result = await fn();
      const ms = Date.now() - start;
      if (kind === 'api') this.trackApiLatency(ms, label);
      else if (kind === 'inference') this.trackInferenceLatency(ms);
      else if (kind === 'execution') this.trackExecutionLatency(ms);
      else this.trackDbLatency(ms, label);
      return result;
    } catch (e) {
      const ms = Date.now() - start;
      if (kind === 'database') this.trackDbLatency(ms, label);
      this.trackFailure(`${kind} failed: ${(e as Error).message}`, kind === 'database' ? 'DATABASE' : 'ERROR');
      throw e;
    }
  }

  middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      const start = Date.now();
      res.on('finish', () => {
        const ms = Date.now() - start;
        this.trackApiLatency(ms, `${req.method} ${req.path}`);
        if (res.statusCode >= 500) {
          this.trackFailure(`HTTP ${res.statusCode} ${req.method} ${req.path}`, 'API');
        } else if (res.statusCode >= 400) {
          this.trackError(`HTTP ${res.statusCode} ${req.method} ${req.path}`, 'API');
        }
      });
      next();
    };
  }

  acknowledgeAlert(id: string): boolean {
    const alert = this.alerts.find((a) => a.id === id);
    if (!alert) return false;
    alert.acknowledged = true;
    this.persistAlerts();
    return true;
  }

  getSnapshot() {
    const cpu = this.cpuPercent();
    const ram = this.ramPercent();
    const oneMinAgo = Date.now() - 60000;
    return {
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      thresholds: THRESHOLDS,
      latency: {
        api: { avgMs: avg(this.api), p95Ms: p95(this.api), maxMs: this.api.maxMs, count: this.api.count },
        inference: {
          avgMs: avg(this.inference),
          p95Ms: p95(this.inference),
          maxMs: this.inference.maxMs,
          count: this.inference.count,
        },
        execution: {
          avgMs: avg(this.execution),
          p95Ms: p95(this.execution),
          maxMs: this.execution.maxMs,
          count: this.execution.count,
        },
        database: {
          avgMs: avg(this.database),
          p95Ms: p95(this.database),
          maxMs: this.database.maxMs,
          count: this.database.count,
        },
      },
      system: {
        cpuPercent: cpu,
        ramPercent: ram,
        totalMemMb: Math.round(os.totalmem() / 1024 / 1024),
        freeMemMb: Math.round(os.freemem() / 1024 / 1024),
        loadAvg: os.loadavg(),
      },
      errors: {
        total: this.errors.length,
        lastMinute: this.errors.filter((e) => new Date(e.at).getTime() >= oneMinAgo).length,
        recent: this.errors.slice(-20).reverse(),
      },
      failures: {
        total: this.failures.length,
        recent: this.failures.slice(-20).reverse(),
      },
      broker: {
        ...this.broker,
        failRate: this.broker.count ? this.broker.fail / this.broker.count : 0,
      },
      alerts: {
        open: this.alerts.filter((a) => !a.acknowledged).length,
        recent: [...this.alerts].reverse().slice(0, 30),
      },
      updatedAt: new Date().toISOString(),
    };
  }
}

export const monitoring = new MonitoringService();
