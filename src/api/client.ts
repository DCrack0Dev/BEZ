import axios, { AxiosError } from 'axios';
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

/**
 * Axios reports every CORS / timeout / non-2xx / DNS error as a generic "Network Error"
 * unless we explicitly unpack it. This surface the actual HTTP status, server payload,
 * and CORS/timeouts details so the UI alerts say something useful.
 */
apiClient.interceptors.response.use(
  (response) => response,
  (error: AxiosError<any>) => {
    const status = error.response?.status ?? 0;
    const data: any = error.response?.data;
    const url = error.config?.url ?? '';
    const method = String(error.config?.method ?? 'GET').toUpperCase();
    const serverMsg =
      (data && (data.error || data.message || data.note)) ||
      (typeof data === 'string' ? data : '') ||
      null;
    // Typical CORS / DNS / offline / TLS failure: no response received.
    if (!error.response) {
      const kind = error.code === 'ECONNABORTED' || /timeout/.test(error.message || '')
        ? `Timeout (${(error.config?.timeout ?? 30000) / 1000}s)`
        : error.code === 'ERR_NETWORK' || !status
          ? 'Network / CORS / offline'
          : error.message || 'Network Error';
      const enhanced = new Error(
        `${method} ${url} failed: ${kind}${serverMsg ? ' — ' + serverMsg : ''}`
      ) as any;
      enhanced.isNetworkError = true;
      enhanced.status = status;
      enhanced.data = data;
      enhanced.code = error.code;
      enhanced.cause = error;
      throw enhanced;
    }
    // Server returned a non-2xx response: attach payload + status so UI can show.
    const enhanced = new Error(
      `${method} ${url} ${status}${serverMsg ? ': ' + String(serverMsg) : ''}`
    ) as any;
    enhanced.status = status;
    enhanced.data = data;
    enhanced.code = error.code;
    enhanced.cause = error;
    throw enhanced;
  }
);

export default apiClient;
