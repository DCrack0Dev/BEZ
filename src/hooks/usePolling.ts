import { useState, useEffect, useCallback, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { getAccountData, setBotConfig, closeOrder } from '../api/orders';
import { useTradeStore } from '../store/useTradeStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useLogStore } from '../store/useLogStore';
import { useAuthStore } from '../store/useAuthStore';

/**
 * usePolling.ts (UI Only)
 * Mobile app hook to update UI based on backend WebSocket heartbeats.
 * No trading logic here!
 */

export const usePolling = () => {
  const { 
    setAccount, 
    setAccountPrice,
    setOpenPositions, 
    setError, 
    setLoading, 
    setLastSignalReason
  } = useTradeStore();
  const { botSettings } = useSettingsStore();
  const { addLog } = useLogStore();
  const { serverUrl } = useAuthStore();
  
  const socketRef = useRef<Socket | null>(null);
  const prevAutoTrading = useRef<boolean>(botSettings.autoTradingEnabled);
  
  // Initialize WebSocket for real-time state updates
  useEffect(() => {
    const url = serverUrl || 'https://liquibot-back.onrender.com';
    socketRef.current = io(url);

    socketRef.current.on('EA_HEARTBEAT', (data) => {
      // Update UI state from backend heartbeat
      if (data.price) {
        setAccountPrice(Number(data.price));
      }
      
      setAccount({
        ...data,
        eaConnected: data.ea_connected,
        eaSymbol: data.symbol || 'XAUUSD',
        currency: data.currency || 'USD',
        price: Number(data.price || 0),
        equity: Number(data.equity || data.account_equity || 0),
        balance: Number(data.balance || data.account_balance || 0),
        pnlToday: Number(data.pnl_today || data.pnlToday || 0),
        fastEMA: Number(data.ema20 || 0),
        slowEMA: Number(data.ema50 || 0),
        atr: Number(data.atr14 || 0),
        spread: Number(data.spread || 0),
      });

      // Update open positions
      const openPositions = (data.positions || []).map((p: any) => ({
        ticket: String(p.ticket),
        symbol: p.symbol,
        type: p.type,
        lots: p.volume || p.lots || 0,
        openPrice: p.openPrice || p.price || 0,
        currentPrice: data.price || p.price || 0,
        profit: Number(p.profit || p.pnl || 0),
        pnl: Number(p.profit || p.pnl || 0),
        openTime: p.time ? new Date(Number(p.time) * 1000).toISOString() : new Date().toISOString(),
      }));
      setOpenPositions(openPositions);

      // Log signal reason if provided
      if (data.lastSignalReason) {
        setLastSignalReason(data.lastSignalReason);
        if (!data.lastSignalReason.startsWith('Searching')) {
          addLog({
            level: data.lastSignalReason.includes('✅') ? 'success' : 'info',
            message: data.lastSignalReason,
            timestamp: new Date().toISOString(),
          });
        }
      }
    });

    socketRef.current.on('TRADE_SIGNAL', (data) => {
      addLog({
        level: 'success',
        message: `🚀 SIGNAL: ${data.signal?.direction || 'UNKNOWN'} ${data.signal?.symbol || 'XAUUSD'}`,
        timestamp: new Date().toISOString(),
      });
    });

    socketRef.current.on('STOP_UPDATE', (data) => {
      addLog({
        level: 'info',
        message: `🛡️ TS Update: #${data.positionTicket} → SL ${data.newStopLoss} (Phase ${data.phase})`,
        timestamp: new Date().toISOString(),
      });
    });

    return () => {
      socketRef.current?.disconnect();
    };
  }, [serverUrl, setAccountPrice, setAccount, setOpenPositions, setLastSignalReason, addLog]);

  // Initial refresh and periodic check
  const refresh = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const accountData = await getAccountData();
      if (!accountData) return;

      setAccount({
        ...accountData,
        eaConnected: accountData.ea_connected,
        eaSymbol: accountData.symbol || 'XAUUSD',
        currency: accountData.currency || 'USD',
        price: Number(accountData.price || 0),
        equity: Number(accountData.equity || accountData.account_equity || 0),
        balance: Number(accountData.balance || accountData.account_balance || 0),
        pnlToday: Number(accountData.pnl_today || accountData.pnlToday || 0),
        fastEMA: Number(accountData.ema20 || 0),
        slowEMA: Number(accountData.ema50 || 0),
        atr: Number(accountData.atr14 || 0),
        spread: Number(accountData.spread || 0),
      });

      setAccountPrice(Number(accountData.price || 0));
      
      const openPositions = (accountData.positions || []).map((p: any) => ({
        ticket: String(p.ticket),
        symbol: p.symbol,
        type: p.type,
        lots: p.volume || p.lots || 0,
        openPrice: p.openPrice || p.price || 0,
        currentPrice: accountData.price || p.price || 0,
        profit: Number(p.profit || p.pnl || 0),
        pnl: Number(p.profit || p.pnl || 0),
        openTime: p.time ? new Date(Number(p.time) * 1000).toISOString() : new Date().toISOString(),
      }));
      setOpenPositions(openPositions);

      // Sync auto trading setting to backend
      if (accountData.ea_connected && prevAutoTrading.current !== botSettings.autoTradingEnabled) {
        prevAutoTrading.current = botSettings.autoTradingEnabled;
        await setBotConfig({ autoTradingEnabled: botSettings.autoTradingEnabled });
        addLog({
          level: 'info',
          message: `⚙️ Auto Trading ${botSettings.autoTradingEnabled ? 'ENABLED' : 'DISABLED'}`,
          timestamp: new Date().toISOString(),
        });
      }

      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Refresh failed');
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [setAccount, setAccountPrice, setOpenPositions, setError, setLoading, botSettings, setBotConfig, addLog]);

  useEffect(() => {
    refresh(true);
    const interval = setInterval(() => {
      refresh(false);
    }, 5000); 
    return () => clearInterval(interval);
  }, [refresh]);

  return { refresh };
};
