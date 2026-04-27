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
}

export interface AccountData {
  balance: number;
  equity: number;
  pnlToday: number;
  eaConnected: boolean;
  eaSymbol: string;
}

interface TradeState {
  account: AccountData;
  openPositions: Position[];
  closedPositions: Position[];
  isLoading: boolean;
  error: string | null;
  setAccount: (account: AccountData) => void;
  setOpenPositions: (positions: Position[]) => void;
  setClosedPositions: (positions: Position[]) => void;
  setLoading: (isLoading: boolean) => void;
  setError: (error: string | null) => void;
}

export const useTradeStore = create<TradeState>((set) => ({
  account: {
    balance: 0,
    equity: 0,
    pnlToday: 0,
    eaConnected: false,
    eaSymbol: 'XAUUSD',
  },
  openPositions: [],
  closedPositions: [],
  isLoading: false,
  error: null,
  setAccount: (account) => set({ account }),
  setOpenPositions: (openPositions) => set({ openPositions }),
  setClosedPositions: (closedPositions) => set({ closedPositions }),
  setLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error }),
}));
