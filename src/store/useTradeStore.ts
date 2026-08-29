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
  aiTradingEnabled?: boolean;
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

function setupProgressSame(a: any, b: any): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.overallProgress !== b.overallProgress) return false;
  if (a.summary !== b.summary) return false;
  if (a.tradeType !== b.tradeType) return false;
  if (a.bias !== b.bias) return false;
  if (a.blockers?.length !== b.blockers?.length) return false;
  if (a.hardGates?.length !== b.hardGates?.length) return false;
  if (a.buyGates?.length !== b.buyGates?.length) return false;
  if (a.sellGates?.length !== b.sellGates?.length) return false;
  return true;
}

export const useTradeStore = create<TradeState>((set, get) => ({
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
  setAccount: (account) => set((state) => {
    const prev = state.account;
    const keys = Object.keys(account) as (keyof AccountData)[];
    let changed = false;
    for (const k of keys) {
      const va = (account as any)[k];
      const vb = (prev as any)[k];
      if (k === 'setupProgress') {
        if (!setupProgressSame(va, vb)) { changed = true; break; }
        continue;
      }
      if (typeof va === 'number' && typeof vb === 'number') {
        if (k === 'spread') {
          if (Math.abs(va - vb) >= 0.5) { changed = true; break; }
        } else {
          if (Math.abs(va - vb) >= 0.01) { changed = true; break; }
        }
        continue;
      }
      if (va !== vb) { changed = true; break; }
    }
    if (!changed) return state;
    return { account: { ...prev, ...account } };
  }),
  setAccountPrice: (price) => set((state) => {
    const prev = state.account;
    if (typeof prev.price === 'number' && typeof price === 'number') {
      if (Math.abs(prev.price - price) < 0.05 && prev.price === prev.price /* not NaN */) {
        if (price === prev.price) return state;
      }
    }
    if (prev.price === price) return state;
    return { account: { ...prev, price } };
  }),
  setOpenPositions: (openPositions) => set((state) => {
    const prev = state.openPositions;
    if (prev.length === openPositions.length) {
      let same = true;
      for (let i = 0; i < prev.length; i++) {
        const a = prev[i];
        const b = openPositions[i];
        if (a.ticket !== b.ticket) { same = false; break; }
        if (a.type !== b.type) { same = false; break; }
        if (Math.abs(Number(a.profit || 0) - Number(b.profit || 0)) > 0.05) { same = false; break; }
        if (Math.abs(Number(a.currentPrice || 0) - Number(b.currentPrice || 0)) > 0.05) { same = false; break; }
      }
      if (same) return state;
    }
    return { openPositions };
  }),
  setClosedPositions: (closedPositions) => set({ closedPositions }),
  setStructures: (structures) => set({ structures }),
  setActiveTimeframe: (activeTimeframe) => set({ activeTimeframe }),
  setLastSignalReason: (lastSignalReason) => set((state) =>
    state.lastSignalReason === lastSignalReason ? state : { lastSignalReason }
  ),
  setSetupProgress: (setupProgress) => set((state) => {
    if (setupProgressSame(state.setupProgress, setupProgress) &&
        setupProgressSame(state.account.setupProgress, setupProgress)) {
      return state;
    }
    return {
      setupProgress,
      account: { ...state.account, setupProgress },
    };
  }),
  setKeyLevelInfo: (keyLevelInfo) => set((state) => ({ account: { ...state.account, keyLevelInfo } })),
  setLoading: (isLoading) => set((state) => state.isLoading === isLoading ? state : { isLoading }),
  setError: (error) => set((state) => state.error === error ? state : { error }),
}));
