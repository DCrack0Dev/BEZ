import apiClient from './client';

export const getApiSettings = async () => {
  const response = await apiClient.get('/api/settings');
  return response.data;
};

export const updateApiSettings = async (settings: any) => {
  const response = await apiClient.put('/api/settings', settings);
  return response.data;
};
