import apiClient from './client';

export interface AIDashboardData {
  productionVersion: string | null;
  aiConfidence: number | null;
  trainingStatus: 'IDLE' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  currentTrainingVersion: string | null;
  models: any[];
  trainingRuns: any[];
  tradeHistory: any[];
  equityCurve: number[];
  drawdown: number;
  riskExposure: number;
  predictionHistory: any[];
  tradeAnalytics: {
    trades: number;
    winRate: number;
    profitFactor: number;
    averageRr: number;
    totalPnl: number;
  };
  modelPerformance: any;
  readOnlyProduction: true;
  cloudMode?: boolean;
  trainingDataSource?: string | null;
}

export interface TrainingStatusPayload {
  status: 'IDLE' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  currentVersion: string | null;
  dataSource?: string | null;
  cloudMode?: boolean;
  lastResult?: {
    success?: boolean;
    best_candidate?: string;
    deployment_recommendation?: string;
    auto_promoted?: boolean;
    message?: string;
    error?: string;
  } | null;
  readOnlyProduction: true;
}

export async function fetchAIDashboard(): Promise<AIDashboardData> {
  const res = await apiClient.get('/api/ai/dashboard');
  return res.data.data ?? res.data;
}

export async function fetchTrainingStatus(): Promise<TrainingStatusPayload> {
  const res = await apiClient.get('/api/ai/training/status');
  return res.data.data ?? res.data;
}

/** Start cloud training (returns immediately — poll fetchTrainingStatus). */
export async function startAITraining(payload?: {
  version?: string;
  epochs?: number;
  dataPath?: string;
}) {
  const res = await apiClient.post('/api/ai/train', payload || { epochs: 40 }, {
    // 202 Accepted — server trains in background; do not wait for full job
    validateStatus: (s) => (s >= 200 && s < 300) || s === 409,
    timeout: 60000,
  });
  return res.data;
}

export async function promoteAIModel(version: string) {
  const res = await apiClient.post(
    '/api/ai/promote',
    { version },
    { timeout: 120000 }
  );
  return res.data;
}

/** Poll until training leaves RUNNING (or timeout). */
export async function waitForTraining(options?: {
  intervalMs?: number;
  timeoutMs?: number;
  onTick?: (status: TrainingStatusPayload) => void;
}): Promise<TrainingStatusPayload> {
  const intervalMs = options?.intervalMs ?? 4000;
  const timeoutMs = options?.timeoutMs ?? 20 * 60 * 1000;
  const started = Date.now();
  let sawRunning = false;

  while (Date.now() - started < timeoutMs) {
    const status = await fetchTrainingStatus();
    options?.onTick?.(status);

    if (status.status === 'RUNNING') {
      sawRunning = true;
    }

    // Prefer seeing RUNNING first so we don't return a stale COMPLETED from a prior job.
    if (sawRunning && (status.status === 'COMPLETED' || status.status === 'FAILED')) {
      return status;
    }

    // Job finished so fast we never observed RUNNING
    if (
      !sawRunning &&
      Date.now() - started > 8000 &&
      (status.status === 'COMPLETED' || status.status === 'FAILED')
    ) {
      return status;
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('Training timed out while waiting for server status');
}
