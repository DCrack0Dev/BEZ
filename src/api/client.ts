import axios from 'axios';
import { useAuthStore } from '../store/useAuthStore';

const MOCK_MODE = false; // Set to false when backend is ready

const apiClient = axios.create({
  baseURL: 'https://liquibot-back.onrender.com', // Default backend URL - will be overridden by user input
  timeout: 30000,
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
// Mock mode is disabled - all requests go to real backend

export default apiClient;
