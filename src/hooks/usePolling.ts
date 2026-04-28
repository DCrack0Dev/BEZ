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

  const lastTradeTimeRef = useRef<number>(0);

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

      // --- APP-BASED TRADING BRAIN (Executioner) ---
      if (botSettings.autoTradingEnabled && accountData.ea_connected) {
        const chart = accountData.chart || [];
        const price = accountData.price || 0;
        const fastEMA = accountData.fastEMA || 0;
        const slowEMA = accountData.slowEMA || 0;
        const equity = accountData.equity || 1000;
        
        // 5 to 15 trades max based on account size
        const dynamicMaxTrades = Math.max(5, Math.min(15, Math.floor(equity / 1000)));
        const totalOpen = openOrders.length;

        // Ensure we have enough data and space for new trades
        if (fastEMA > 0 && slowEMA > 0 && chart.length >= 2 && totalOpen < dynamicMaxTrades) {
          // Sort chart to ensure x=1 is the most recent closed candle
          const sortedChart = [...chart].sort((a, b) => a.x - b.x);
          const c1 = sortedChart[0]; // Latest closed candle
          
          const isBullishTrend = fastEMA > slowEMA;
          const isBearishTrend = fastEMA < slowEMA;
          
          let signal: 'BUY' | 'SELL' | 'NONE' = 'NONE';

          // Pullback / Retracement Filter Logic:
          // We only enter in the direction of the trend IF the short-term momentum (last candle & current price action) agrees.
          if (isBullishTrend) {
            const isC1Bullish = c1.close > c1.open;
            const breakingOut = price > c1.high;
            
            // If c1 was bearish, price is in a pullback. Do not buy!
            // Wait for a bullish closed candle AND price to break its high (resumption).
            if (isC1Bullish && breakingOut) {
              signal = 'BUY';
            }
          } else if (isBearishTrend) {
            const isC1Bearish = c1.close < c1.open;
            const breakingOut = price < c1.low;
            
            // If c1 was bullish, price is in a pullback. Do not sell!
            // Wait for a bearish closed candle AND price to break its low (resumption).
            if (isC1Bearish && breakingOut) {
              signal = 'SELL';
            }
          }

          // Throttle trades to max 1 every 10 seconds to prevent overwhelming the broker/EA
          const now = Date.now();
          if (signal !== 'NONE' && (now - lastTradeTimeRef.current > 10000)) {
            lastTradeTimeRef.current = now;
            console.log(`🚀 APP BRAIN SIGNAL: ${signal} | Trend: ${isBullishTrend ? 'BULL' : 'BEAR'} | Open: ${totalOpen}/${dynamicMaxTrades}`);
            placeOrder({
              symbol: accountData.ea_symbol || 'XAUUSD',
              type: signal,
              lots: 0, // EA will calculate lot size based on equity
              sl: 0,   // EA will use its points setting
              tp: 0
            }).catch(e => console.error("App brain trade execution failed:", e));
          }
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
