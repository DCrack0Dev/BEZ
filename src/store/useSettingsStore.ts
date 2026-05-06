import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface BotSettings {
  defaultLots: number;
  stopLoss: number;
  takeProfit: number;
  maxOpenTrades: number;
  trailingStopEnabled: boolean;
  sessionFilterEnabled: boolean;
  autoTradingEnabled: boolean;
  executionMode: 'app' | 'backend';
}

interface NotificationSettings {
  tradeOpened: boolean;
  tradeClosed: boolean;
  dailySummary: boolean;
  eaDisconnected: boolean;
}

interface SettingsState {
  botSettings: BotSettings;
  notifications: NotificationSettings;
  subscription: {
    plan: string;
    status: string;
    expiry: string;
  };
  updateBotSettings: (settings: Partial<BotSettings>) => Promise<void>;
  updateNotifications: (settings: Partial<NotificationSettings>) => Promise<void>;
  setSubscription: (sub: SettingsState['subscription']) => void;
  loadSettings: () => Promise<void>;
}

const DEFAULT_BOT_SETTINGS: BotSettings = {
  defaultLots: 0.01,
  stopLoss: 100,
  takeProfit: 200,
  maxOpenTrades: 5,
  trailingStopEnabled: false,
  sessionFilterEnabled: true,
  autoTradingEnabled: false,
  executionMode: 'app',
};

const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  tradeOpened: true,
  tradeClosed: true,
  dailySummary: true,
  eaDisconnected: true,
};

export const useSettingsStore = create<SettingsState>((set, get) => ({
  botSettings: DEFAULT_BOT_SETTINGS,
  notifications: DEFAULT_NOTIFICATION_SETTINGS,
  subscription: {
    plan: 'Basic',
    status: 'Active',
    expiry: '2026-12-31',
  },
  updateBotSettings: async (settings) => {
    const newSettings = { ...get().botSettings, ...settings };
    await AsyncStorage.setItem('botSettings', JSON.stringify(newSettings));
    set({ botSettings: newSettings });
  },
  updateNotifications: async (settings) => {
    const newNotifications = { ...get().notifications, ...settings };
    await AsyncStorage.setItem('notifications', JSON.stringify(newNotifications));
    set({ notifications: newNotifications });
  },
  setSubscription: (subscription) => set({ subscription }),
  loadSettings: async () => {
    try {
      const botSettings = await AsyncStorage.getItem('botSettings');
      const notifications = await AsyncStorage.getItem('notifications');
      if (botSettings) {
        const parsed = JSON.parse(botSettings);
        set({ botSettings: { ...DEFAULT_BOT_SETTINGS, ...parsed } });
      }
      if (notifications) {
        const parsed = JSON.parse(notifications);
        set({ notifications: { ...DEFAULT_NOTIFICATION_SETTINGS, ...parsed } });
      }
    } catch (error) {
      console.error('[SETTINGS] Error loading settings:', error);
      // Keep default settings on error
    }
  },
}));
