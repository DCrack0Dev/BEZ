import axios from 'axios';
import { useAuthStore } from '../store/useAuthStore';

const DEFAULT_API_URL =
  process.env.EXPO_PUBLIC_API_URL || 'https://liquibot-back.onrender.com';

const apiClient = axios.create({
  baseURL: DEFAULT_API_URL,
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
});

apiClient.interceptors.request.use((config) => {
  const { jwt, serverUrl, apiKey } = useAuthStore.getState();

  // Always prefer the URL the user entered at login when present.
  if (serverUrl) {
    config.baseURL = serverUrl.replace(/\/$/, '');
  }

  if (jwt) {
    config.headers.Authorization = `Bearer ${jwt}`;
  }
  if (apiKey) {
    config.headers['x-api-key'] = apiKey;
  }
  return config;
});

export default apiClient;
