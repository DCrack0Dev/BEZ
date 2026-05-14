import { useState, useEffect, useCallback, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { getAccountData, placeOrder, setBotConfig } from '../api/orders';
import { useTradeStore } from '../store/useTradeStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useLogStore } from '../store/useLogStore';
import { useAuthStore } from '../store/useAuthStore';

/**
 * usePolling.ts (Execution Brain)
 * Mobile app's execution brain. Manages real-time WebSocket signals and polling.
 */

interface Candle {
  x: number;
  open: number;
  high: number;
  low: number;
  close: number;
  tick_volume?: number;
  timestamp: number;
}

export const usePolling = () => {
  const { 
    setAccount, 
    setAccountPrice,
    setOpenPositions, 
    setError, 
    setLoading, 
  } = useTradeStore();
  const { botSettings } = useSettingsStore();
  const { addLog } = useLogStore();
  const { serverUrl } = useAuthStore();
  
  const socketRef = useRef<Socket | null>(null);
  const lastTradeTimeRef = useRef<number>(0);
  const prevAutoTrading = useRef<boolean>(botSettings.autoTradingEnabled);

  // Initialize WebSocket for real-time signals
  useEffect(() => {
    const url = serverUrl || 'http://192.168.8.151:5000';
    socketRef.current = io(url);

    socketRef.current.on('EA_HEARTBEAT', (data) => {
      if (data.price) {
        setAccountPrice(Number(data.price));
      }
      handleAppBrainAnalysis(data);
    });

    return () => {
      socketRef.current?.disconnect();
    };
  }, [serverUrl, setAccountPrice]);

  const handleAppBrainAnalysis = useCallback(async (accountData: any) => {
    if (!botSettings.autoTradingEnabled || (botSettings.executionMode || 'app') !== 'app') return;
    
    // --- APP-BASED TRADING BRAIN ---
    const chart = accountData.chart || [];
    const price = Number(accountData.price || 0);
    const fastEMA = Number(accountData.ema20 || accountData.fastEMA || 0);
    const slowEMA = Number(accountData.ema50 || accountData.slowEMA || 0);
    const equity = Number(accountData.equity || 1000);
    const openOrders = accountData.positions || [];
    
    // 5 to 15 trades max based on account size
    const dynamicMaxTrades = Math.max(5, Math.min(15, Math.floor(equity / 1000)));
    const totalOpen = openOrders.length;

    let m5Chart: Candle[] = [];
    if (typeof chart === 'object' && !Array.isArray(chart)) {
      m5Chart = chart['M5'] || [];
    } else if (Array.isArray(chart)) {
      m5Chart = chart;
    }

    if (fastEMA > 0 && slowEMA > 0 && m5Chart.length >= 2 && totalOpen < dynamicMaxTrades) {
      // Sort chart to ensure index 0 is the most recent closed candle
      const sortedChart = [...m5Chart].sort((a, b) => b.x - a.x);
      const c1 = sortedChart[0]; 
      
      const isBullishTrend = fastEMA > slowEMA;
      const isBearishTrend = fastEMA < slowEMA;
      
      let signal: 'BUY' | 'SELL' | 'NONE' = 'NONE';

      // Pullback / Retracement Filter Logic:
      if (isBullishTrend) {
        const isC1Bullish = c1.close > c1.open;
        const breakingOut = price > c1.high;
        
        // Only buy if trend is bull AND last candle was bullish (pullback ended) AND price is breaking out
        if (isC1Bullish && breakingOut) {
          signal = 'BUY';
        }
      } else if (isBearishTrend) {
        const isC1Bearish = c1.close < c1.open;
        const breakingOut = price < c1.low;
        
        // Only sell if trend is bear AND last candle was bearish (pullback ended) AND price is breaking out
        if (isC1Bearish && breakingOut) {
          signal = 'SELL';
        }
      }

      // Throttle trades to max 1 every 10 seconds
      const now = Date.now();
      if (signal !== 'NONE' && (now - lastTradeTimeRef.current > 10000)) {
        lastTradeTimeRef.current = now;
        addLog({
          level: 'info',
          message: `🚀 APP BRAIN SIGNAL: ${signal} | Trend: ${isBullishTrend ? 'BULL' : 'BEAR'} | Open: ${totalOpen}/${dynamicMaxTrades}`,
          timestamp: new Date().toISOString()
        });

        placeOrder({
          symbol: accountData.symbol || accountData.ea_symbol || 'XAUUSD',
          type: signal,
          lots: 0, // EA handles lots
          sl: 0,   // EA handles SL
          tp: 0
        }).catch(e => console.error("App brain trade execution failed:", e));
      }
    }
  }, [botSettings, addLog]);

  const refresh = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const accountData = await getAccountData();
      if (!accountData) return;

      // Update state for UI
      setAccount({
        ...accountData,
        eaConnected: accountData.ea_connected,
        eaSymbol: accountData.symbol || 'XAUUSD',
        price: Number(accountData.price || 0),
        equity: Number(accountData.equity || 0),
        balance: Number(accountData.balance || 0),
        pnlToday: Number(accountData.pnl_today || accountData.pnlToday || 0),
      });

      setAccountPrice(Number(accountData.price || 0));
      
      const openPositions = (accountData.positions || []).map((p: any) => ({
        ticket: String(p.ticket),
        symbol: p.symbol,
        type: p.type,
        lots: p.volume || p.lots || 0,
        openPrice: p.openPrice || p.price || 0,
        currentPrice: accountData.price || p.price || 0,
        profit: p.profit || 0,
        pnl: p.profit || 0,
        openTime: p.time ? new Date(Number(p.time) * 1000).toISOString() : new Date().toISOString(),
      }));
      setOpenPositions(openPositions);

      // Sync bot settings with EA (PAUSE/RESUME)
      if (accountData.ea_connected && prevAutoTrading.current !== botSettings.autoTradingEnabled) {
        prevAutoTrading.current = botSettings.autoTradingEnabled;
        placeOrder({
          symbol: accountData.symbol || 'XAUUSD',
          type: botSettings.autoTradingEnabled ? 'RESUME' : 'PAUSE',
          lots: 0, sl: 0, tp: 0
        }).catch(e => console.error("Auto-trade sync failed:", e));
      }

      // Run Brain Analysis if not in real-time mode or as a backup
      handleAppBrainAnalysis(accountData);

      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Refresh failed');
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [setAccount, setAccountPrice, setOpenPositions, setError, setLoading, handleAppBrainAnalysis, botSettings]);

  useEffect(() => {
    refresh(true);
    const interval = setInterval(() => {
      refresh(false);
    }, 3000); 
    return () => clearInterval(interval);
  }, [refresh]);

  return { refresh };
};
