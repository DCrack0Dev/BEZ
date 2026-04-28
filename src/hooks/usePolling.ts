import { useEffect, useCallback, useRef } from 'react';
import { useTradeStore } from '../store/useTradeStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { getAccountData } from '../api/account';
import { getOpenOrders, placeOrder } from '../api/orders';

export const usePolling = () => {
  const { setAccount, setOpenPositions, setLoading, setError, openPositions } = useTradeStore();
  const { botSettings } = useSettingsStore();
  const lastSignalRef = useRef<'BUY' | 'SELL' | 'NONE'>('NONE');

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

      // Auto Trading Logic (App acts as the brain)
      if (botSettings.autoTradingEnabled && accountData.ea_connected) {
        let currentSignal: 'BUY' | 'SELL' | 'NONE' = 'NONE';
        if (accountData.fastEMA > accountData.slowEMA && accountData.slowEMA > 0) {
          currentSignal = 'BUY';
        } else if (accountData.fastEMA < accountData.slowEMA && accountData.fastEMA > 0) {
          currentSignal = 'SELL';
        }

        // Only act on a fresh signal and respect max trades
        if (
          currentSignal !== 'NONE' &&
          currentSignal !== lastSignalRef.current &&
          openOrders.length < botSettings.maxOpenTrades
        ) {
          // Check if we already have a trade in this direction to avoid duplicates
          const hasTradeInDirection = openOrders.some((pos: any) => pos.type === currentSignal);
          if (!hasTradeInDirection) {
            console.log(`🤖 Auto-trading: Opening ${currentSignal} on ${accountData.ea_symbol || 'XAUUSD'}`);
            placeOrder({
              symbol: accountData.ea_symbol || 'XAUUSD',
              type: currentSignal,
              lots: botSettings.defaultLots,
              sl: botSettings.stopLoss,
              tp: botSettings.takeProfit
            }).catch(e => console.error("Auto-trade failed:", e));
          }
        }
        lastSignalRef.current = currentSignal;
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
