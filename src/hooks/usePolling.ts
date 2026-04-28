import React, { useEffect, useCallback, useRef } from 'react';
import { useTradeStore } from '../store/useTradeStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { getAccountData } from '../api/account';
import { getOpenOrders, placeOrder } from '../api/orders';

export const usePolling = () => {
  const { setAccount, setOpenPositions, setLoading, setError, openPositions } = useTradeStore();
  const { botSettings } = useSettingsStore();
  const lastSignalRef = useRef<'BUY' | 'SELL' | 'NONE'>('NONE');
  const prevAutoTrading = useRef<boolean>(botSettings.autoTradingEnabled);

  const refresh = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const [accountData, openOrders] = await Promise.all([
        getAccountData(),
        getOpenOrders(),
      ]);
      
      setAccount({
        balance: accountData.balance,
        equity: accountData.equity,
        pnlToday: accountData.pnl_today,
        eaConnected: accountData.ea_connected,
        eaSymbol: accountData.ea_symbol || 'XAUUSD',
        price: accountData.price || 0,
        fastEMA: accountData.fastEMA || 0,
        slowEMA: accountData.slowEMA || 0,
        bbUpper: accountData.bbUpper || 0,
        bbLower: accountData.bbLower || 0,
        chart: accountData.chart || [],
      });
      
      setOpenPositions(openOrders);
      setError(null);

      // Sync botSettings.autoTradingEnabled to backend so EA knows
      if (prevAutoTrading.current !== botSettings.autoTradingEnabled) {
        prevAutoTrading.current = botSettings.autoTradingEnabled;
        if (accountData.ea_connected) {
          console.log(`🤖 Sending Auto-trading state to EA: ${botSettings.autoTradingEnabled ? 'RESUME' : 'PAUSE'}`);
          placeOrder({
            symbol: accountData.ea_symbol || 'XAUUSD',
            type: botSettings.autoTradingEnabled ? 'RESUME' : 'PAUSE',
            lots: 0,
            sl: 0,
            tp: 0
          }).catch(e => console.error("Auto-trade sync failed:", e));
        }
      }

    } catch (error) {
      console.error('Polling error:', error);
      setError('Connection lost. Retrying...');
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [setAccount, setOpenPositions, setLoading, setError, botSettings]);

  useEffect(() => {
    refresh(true);
    const interval = setInterval(() => refresh(false), 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  return { refresh };
};
