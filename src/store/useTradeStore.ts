import { create } from 'zustand';

export interface Position {
  ticket: string;
  symbol: string;
  type: 'BUY' | 'SELL';
  lots: number;
  openPrice: number;
  currentPrice: number;
  pnl: number;
  openTime: string;
  sl?: number;
  tp?: number;
}

export interface SetupRequirement {
  id: string;
  label: string;
  detail: string;
  expected: string;
  actual: string;
  met: boolean;
  progress: number;
}

export interface SetupProgress {
  updatedAt: number;
  session: string;
  timezoneTradingEnabled: boolean;
  trend: string;
  bias: 'BUY' | 'SELL' | 'NONE';
  tradeType: 'BUY' | 'SELL' | 'WAITING';
  overallProgress: number;
  summary: string;
  hardGates: SetupRequirement[];
  buyGates: SetupRequirement[];
  sellGates: SetupRequirement[];
  blockers: string[];
}

export interface AccountData {
  balance: number;
  equity: number;
  pnlToday: number;
  eaConnected: boolean;
  eaSymbol: string;
  currency: string;
  price: number;
  fastEMA: number;
  slowEMA: number;
  bbUpper: number;
  bbLower: number;
  rsi?: number;
  atr?: number;
  vwap?: number;
  spread?: number;
  tickVolume?: number;
  chart: any;
  keyLevelInfo?: { level: number; distance: number; type: string };
  logs?: any[];
  setupProgress?: SetupProgress | null;
  timezoneTradingEnabled?: boolean;
  autoTradingEnabled?: boolean;
}

interface TradeState {
  account: AccountData;
  openPositions: Position[];
  closedPositions: Position[];
  structures: any;
  activeTimeframe: string;
  lastSignalReason: string;
  setupProgress: SetupProgress | null;
  isLoading: boolean;
  error: string | null;
  setAccount: (account: AccountData) => void;
  setAccountPrice: (price: number) => void;
  setOpenPositions: (positions: Position[]) => void;
  setClosedPositions: (positions: Position[]) => void;
  setStructures: (structures: any) => void;
  setActiveTimeframe: (timeframe: string) => void;
  setLastSignalReason: (reason: string) => void;
  setSetupProgress: (progress: SetupProgress | null) => void;
  setKeyLevelInfo: (info: { level: number; distance: number; type: string }) => void;
  setLoading: (isLoading: boolean) => void;
  setError: (error: string | null) => void;
}

export const useTradeStore = create<TradeState>((set) => ({
  account: {
    balance: 0,
    equity: 0,
    pnlToday: 0,
    eaConnected: false,
    eaSymbol: '---',
    currency: 'USD',
    price: 0,
    fastEMA: 0,
    slowEMA: 0,
    bbUpper: 0,
    bbLower: 0,
    chart: [],
    logs: [],
    setupProgress: null,
  },
  openPositions: [],
  closedPositions: [],
  structures: {},
  activeTimeframe: 'M15',
  lastSignalReason: 'Waiting for Setup...',
  setupProgress: null,
  isLoading: false,
  error: null,
  setAccount: (account) => set({ account }),
  setAccountPrice: (price) => set((state) => ({ 
    account: { ...state.account, price }
  })),
  setOpenPositions: (openPositions) => set({ openPositions }),
  setClosedPositions: (closedPositions) => set({ closedPositions }),
  setStructures: (structures) => set({ structures }),
  setActiveTimeframe: (activeTimeframe) => set({ activeTimeframe }),
  setLastSignalReason: (lastSignalReason) => set({ lastSignalReason }),
  setSetupProgress: (setupProgress) => set((state) => ({
    setupProgress,
    account: { ...state.account, setupProgress },
  })),
  setKeyLevelInfo: (keyLevelInfo) => set((state) => ({ account: { ...state.account, keyLevelInfo } })),
  setLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error }),
}));
