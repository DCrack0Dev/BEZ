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
  if (serverUrl && !config.baseURL) {
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
    if (config.url?.includes('/api/orders/open')) {
      return Promise.reject({
        mockResponse: {
          data: [
            {
              ticket: '123456',
              symbol: 'XAUUSD',
              type: 'BUY',
              lots: 0.1,
              openPrice: 2350.5,
              currentPrice: 2355.2,
              pnl: 47.0,
              openTime: new Date().toISOString(),
            },
            {
              ticket: '123457',
              symbol: 'US30',
              type: 'SELL',
              lots: 0.05,
              openPrice: 38500,
              currentPrice: 38450,
              pnl: 25.0,
              openTime: new Date().toISOString(),
            },
          ],
        },
      });
    }
    if (config.url?.includes('/api/signal')) {
      return Promise.reject({
        mockResponse: {
          data: { symbol: 'XAUUSD', tf: 'M5', signal: 'BUY' },
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
