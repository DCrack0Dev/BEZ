import axios from 'axios';
import { useAuthStore } from '../store/useAuthStore';

const MOCK_MODE = false; // Set to false when backend is ready

const apiClient = axios.create({
  baseURL: 'https://liquibot-back.onrender.com', // Live backend URL
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
});

apiClient.interceptors.request.use((config) => {
  const { jwt, serverUrl, apiKey } = useAuthStore.getState();
  if (serverUrl) {
    config.baseURL = serverUrl;
  }
  if (jwt) {
    config.headers.Authorization = `Bearer ${jwt}`;
  }
  if (apiKey) {
    config.headers['x-api-key'] = apiKey;
  }
  return config;
});

// Mock Data Interceptor
if (MOCK_MODE) {
  apiClient.interceptors.request.use(async (config) => {
    // If it's a mock request, we'll handle it here and "throw" a custom response
    if (config.url?.includes('/api/auth/validate')) {
      return Promise.reject({ mockResponse: { data: { token: 'mock-jwt-token' } } });
    }
    if (config.url?.includes('/api/account')) {
      return Promise.reject({
        mockResponse: {
          data: {
            balance: 10000,
            equity: 10243,
            pnl_today: 243,
            ea_connected: true,
          },
        },
      });
    }
    if (config.url?.includes('/api/order')) {
      return Promise.reject({
        mockResponse: { data: { success: true, ticket: Math.floor(Math.random() * 1000000).toString() } },
      });
    }
    return config;
  });

  apiClient.interceptors.response.use(
    (response) => response,
    (error) => {
      if (error.mockResponse) {
        return Promise.resolve(error.mockResponse);
      }
      return Promise.reject(error);
    }
  );
}

export default apiClient;
