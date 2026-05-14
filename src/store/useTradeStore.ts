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

export interface AccountData {
  balance: number;
  equity: number;
  pnlToday: number;
  eaConnected: boolean;
  eaSymbol: string;
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
}

interface TradeState {
  account: AccountData;
  openPositions: Position[];
  closedPositions: Position[];
  structures: any;
  activeTimeframe: string;
  lastSignalReason: string;
  isLoading: boolean;
  error: string | null;
  setAccount: (account: AccountData) => void;
  setAccountPrice: (price: number) => void;
  setOpenPositions: (positions: Position[]) => void;
  setClosedPositions: (positions: Position[]) => void;
  setStructures: (structures: any) => void;
  setActiveTimeframe: (timeframe: string) => void;
  setLastSignalReason: (reason: string) => void;
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
    price: 0,
    fastEMA: 0,
    slowEMA: 0,
    bbUpper: 0,
    bbLower: 0,
    chart: [],
  },
  openPositions: [],
  closedPositions: [],
  structures: {},
  activeTimeframe: 'M15',
  lastSignalReason: '',
  isLoading: false,
  error: null,
  setAccount: (account) => set({ account }),
  setAccountPrice: (price) => set((state) => ({ 
    account: { ...state.account, price },
    openPositions: state.openPositions.map(pos => {
      // Auto-update PnL when price changes
      const point = state.account.eaSymbol.includes('JPY') || state.account.eaSymbol.includes('XAU') ? 0.01 : 0.0001;
      const diff = pos.type === 'BUY' ? (price - pos.openPrice) : (pos.openPrice - price);
      const profit = (diff / point) * pos.lots * (state.account.eaSymbol.includes('XAU') ? 1 : 10);
      return { ...pos, currentPrice: price, pnl: profit, profit };
    })
  })),
  setOpenPositions: (openPositions) => set({ openPositions }),
  setClosedPositions: (closedPositions) => set({ closedPositions }),
  setStructures: (structures) => set({ structures }),
  setActiveTimeframe: (activeTimeframe) => set({ activeTimeframe }),
  setLastSignalReason: (lastSignalReason) => set({ lastSignalReason }),
  setKeyLevelInfo: (keyLevelInfo) => set((state) => ({ account: { ...state.account, keyLevelInfo } })),
  setLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error }),
}));
