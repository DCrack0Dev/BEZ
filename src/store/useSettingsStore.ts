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
    const botSettings = await AsyncStorage.getItem('botSettings');
    const notifications = await AsyncStorage.getItem('notifications');
    if (botSettings) set({ botSettings: JSON.parse(botSettings) });
    if (notifications) set({ notifications: JSON.parse(notifications) });
  },
}));
