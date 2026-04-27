import apiClient from './client';

export const getSignal = async (symbol: string, tf: string) => {
  const response = await apiClient.get(`/api/signal?symbol=${symbol}&tf=${tf}`);
  return response.data;
};
