import apiClient from './client';
import { fetchBacktestStatus, waitForBacktest, cancelBacktest } from './ai';

export async function fetchMonitoring() {
  const res = await apiClient.get('/api/monitoring', { timeout: 30000 });
  return res.data.data ?? res.data;
}

export async function ackAlert(id: string) {
  const res = await apiClient.post(`/api/monitoring/alerts/${id}/ack`, undefined, { timeout: 20000 });
  return res.data;
}

/**
 * Cloud backtest runner. Backend POST now returns 202 Accepted instantly,
 * we poll /api/backtest/status until COMPLETED / FAILED (mirrors train flow).
 * This guarantees no 30s axios timeout on slow Render CPU.
 */
export async function runBacktest(
  payload?: { modelVersion?: string; dataPath?: string },
  options?: { onTick?: (s: any) => void }
) {
  const postRes = await apiClient.post('/api/backtest', payload || {}, {
    timeout: 120000, // Render cold boot + TLS slow sometimes > 30s
    validateStatus: (s) => (s >= 200 && s < 300) || s === 409,
  });
  if (postRes.status === 409) return postRes.data;
  const enqueue = postRes.data;
  if (!enqueue?.accepted) return enqueue || { success: false, error: 'Backend rejected backtest request' };
  const finalStatus = await waitForBacktest({ onTick: options?.onTick });
  if (finalStatus.status === 'COMPLETED' || finalStatus.lastResult?.success) {
    return { success: true, accepted: true, ...(finalStatus.lastResult || {}), ...finalStatus };
  }
  const parts: string[] = [];
  if (finalStatus.lastResult?.error) parts.push(finalStatus.lastResult.error);
  if (finalStatus.stderrTail) parts.push('stderr tail:\n' + finalStatus.stderrTail);
  if (finalStatus.stdoutTail) parts.push('stdout tail:\n' + finalStatus.stdoutTail);
  return {
    success: false,
    accepted: true,
    error: parts.join('\n----\n') || finalStatus.lastResult?.message || 'Backtest failed',
    ...finalStatus,
  };
}

export async function listBacktestReports() {
  const res = await apiClient.get('/api/backtest/reports', { timeout: 30000 });
  return res.data.data ?? res.data;
}

export async function fetchLearningStatus() {
  const res = await apiClient.get('/api/learning/status', { timeout: 30000 });
  return res.data.data ?? res.data;
}

export async function triggerLearningTrain() {
  const res = await apiClient.post('/api/learning/train', undefined, {
    timeout: 60000,
    validateStatus: (s) => (s >= 200 && s < 300) || s === 409,
  });
  return res.data;
}

export async function fetchAuditLog(limit = 50, category?: string) {
  const res = await apiClient.get('/api/audit', { params: { limit, category }, timeout: 30000 });
  return res.data.data ?? res.data;
}

export { fetchBacktestStatus, cancelBacktest };
