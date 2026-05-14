import apiClient from './client';

export const getAccountData = async () => {
  const response = await apiClient.get('/api/account');
  return response.data;
};

export const validateApiKey = async (apiKey: string, baseUrl?: string) => {
  const config = baseUrl ? { baseURL: baseUrl } : {};
  const response = await apiClient.post('/api/ea/validate', { apiKey }, config);
  return response.data;
};

export const getSubscription = async () => {
  const response = await apiClient.get('/api/subscription');
  return response.data;
};
