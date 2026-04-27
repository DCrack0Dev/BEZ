import { useAuthStore } from '../store/useAuthStore';
import apiClient from './client';

export const getOpenOrders = async () => {
  const response = await apiClient.get('/api/account'); // Account endpoint now returns positions
  return response.data.positions || [];
};

export const getClosedOrders = async (filter: 'today' | 'week' | 'month') => {
  const response = await apiClient.get(`/api/orders/closed?filter=${filter}`);
  return response.data;
};

export const placeOrder = async (orderData: {
  symbol: string;
  type: 'BUY' | 'SELL';
  lots: number;
  sl?: number;
  tp?: number;
}) => {
  const { apiKey } = useAuthStore.getState();
  const payload = {
    ...orderData,
    action: orderData.type,
    apiKey
  };
  const response = await apiClient.post('/api/order', payload);
  return response.data;
};

export const closeOrder = async (ticket: string) => {
  const { apiKey } = useAuthStore.getState();
  const response = await apiClient.post('/api/order', { action: 'CLOSE_TRADE', ticket, apiKey });
  return response.data;
};
