import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';

interface AuthState {
  apiKey: string | null;
  serverUrl: string | null;
  jwt: string | null;
  isAuthenticated: boolean;
  setAuth: (apiKey: string, serverUrl: string, jwt: string) => Promise<void>;
  logout: () => Promise<void>;
  loadAuth: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  apiKey: null,
  serverUrl: null,
  jwt: null,
  isAuthenticated: false,
  setAuth: async (apiKey, serverUrl, jwt) => {
    await SecureStore.setItemAsync('apiKey', apiKey);
    await SecureStore.setItemAsync('serverUrl', serverUrl);
    await SecureStore.setItemAsync('jwt', jwt);
    set({ apiKey, serverUrl, jwt, isAuthenticated: true });
  },
  logout: async () => {
    await SecureStore.deleteItemAsync('apiKey');
    await SecureStore.deleteItemAsync('serverUrl');
    await SecureStore.deleteItemAsync('jwt');
    set({ apiKey: null, serverUrl: null, jwt: null, isAuthenticated: false });
  },
  loadAuth: async () => {
    const apiKey = await SecureStore.getItemAsync('apiKey');
    const serverUrl = await SecureStore.getItemAsync('serverUrl');
    const jwt = await SecureStore.getItemAsync('jwt');
    if (apiKey && serverUrl && jwt) {
      set({ apiKey, serverUrl, jwt, isAuthenticated: true });
    }
  },
}));
