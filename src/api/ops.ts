import apiClient from './client';

export async function fetchMonitoring() {
  const res = await apiClient.get('/api/monitoring');
  return res.data.data ?? res.data;
}

export async function ackAlert(id: string) {
  const res = await apiClient.post(`/api/monitoring/alerts/${id}/ack`);
  return res.data;
}

export async function runBacktest(payload?: { modelVersion?: string; dataPath?: string }) {
  const res = await apiClient.post('/api/backtest', payload || {});
  return res.data;
}

export async function listBacktestReports() {
  const res = await apiClient.get('/api/backtest/reports');
  return res.data.data ?? res.data;
}

export async function fetchLearningStatus() {
  const res = await apiClient.get('/api/learning/status');
  return res.data.data ?? res.data;
}

export async function triggerLearningTrain() {
  const res = await apiClient.post('/api/learning/train');
  return res.data;
}

export async function fetchAuditLog(limit = 50, category?: string) {
  const res = await apiClient.get('/api/audit', { params: { limit, category } });
  return res.data.data ?? res.data;
}
