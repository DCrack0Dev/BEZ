import { create } from 'zustand';

export interface LogEntry {
  id: string;
  timestamp: Date;
  component: 'EA' | 'Backend' | 'App' | 'System';
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
  details?: string;
}

interface LogState {
  logs: LogEntry[];
  keyLevelDistance: { level: number; distance: number; type: string } | null;
  addLog: (entry: Omit<LogEntry, 'id' | 'timestamp'>) => void;
  addSystemLog: (message: string, level?: LogEntry['level']) => void;
  addEALog: (message: string, level?: LogEntry['level'], details?: string) => void;
  addBackendLog: (message: string, level?: LogEntry['level'], details?: string) => void;
  addAppLog: (message: string, level?: LogEntry['level'], details?: string) => void;
  clearLogs: () => void;
  setKeyLevelDistance: (level: number, distance: number, type: string) => void;
}

export const useLogStore = create<LogState>((set, get) => ({
  logs: [],
  keyLevelDistance: null,

  addLog: (entry) => {
    const newLog: LogEntry = {
      ...entry,
      id: `${Date.now()}-${Math.random()}`,
      timestamp: new Date(),
    };
    
    set((state) => ({
      logs: [...state.logs.slice(-99), newLog], // Keep last 100 logs
    }));
  },

  addSystemLog: (message, level = 'info') => {
    get().addLog({ component: 'System', level, message });
  },

  addEALog: (message, level = 'info', details) => {
    get().addLog({ component: 'EA', level, message, details });
  },

  addBackendLog: (message, level = 'info', details) => {
    get().addLog({ component: 'Backend', level, message, details });
  },

  addAppLog: (message, level = 'info', details) => {
    get().addLog({ component: 'App', level, message, details });
  },

  clearLogs: () => {
    set({ logs: [] });
  },

  setKeyLevelDistance: (level, distance, type) => {
    set({ keyLevelDistance: { level, distance, type } });
  },
}));

// Helper functions for logging
export const logSystem = (message: string, level?: LogEntry['level']) => {
  useLogStore.getState().addSystemLog(message, level);
};

export const logEA = (message: string, level?: LogEntry['level'], details?: string) => {
  useLogStore.getState().addEALog(message, level, details);
};

export const logBackend = (message: string, level?: LogEntry['level'], details?: string) => {
  useLogStore.getState().addBackendLog(message, level, details);
};

export const logApp = (message: string, level?: LogEntry['level'], details?: string) => {
  useLogStore.getState().addAppLog(message, level, details);
};
