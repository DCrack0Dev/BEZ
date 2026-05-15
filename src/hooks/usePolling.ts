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
    setLastSignalReason
  } = useTradeStore();
  const { botSettings } = useSettingsStore();
  const { addLog } = useLogStore();
  const { serverUrl } = useAuthStore();
  
  const socketRef = useRef<Socket | null>(null);
  const lastTradeTimeRef = useRef<number>(0);
  const lastLogTimeRef = useRef<number>(0);
  const prevAutoTrading = useRef<boolean>(botSettings.autoTradingEnabled);

  // Initialize WebSocket for real-time signals
  useEffect(() => {
    const url = serverUrl || 'https://liquibot-back.onrender.com';
    socketRef.current = io(url);

    socketRef.current.on('EA_HEARTBEAT', (data) => {
      if (data.price) {
        setAccountPrice(Number(data.price));
      }
      
      // Update full account state from heartbeat to ensure status is live
      setAccount({
        ...data,
        eaConnected: data.ea_connected,
        eaSymbol: data.symbol || 'XAUUSD',
        price: Number(data.price || 0),
        equity: Number(data.equity || 0),
        balance: Number(data.balance || 0),
        pnlToday: Number(data.pnl_today || data.pnlToday || 0),
        fastEMA: Number(data.ema20 || 0),
        slowEMA: Number(data.ema50 || 0),
        atr: Number(data.atr14 || 0),
        spread: Number(data.spread || 0),
      });

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

    if (fastEMA > 0 && slowEMA > 0 && m5Chart.length >= 20) {
      // --- MULTI-TIMEFRAME ANALYSIS (Swing & Momentum) ---
      const m15Chart: Candle[] = accountData.chart?.['M15'] || [];
      const h1Chart: Candle[] = accountData.chart?.['H1'] || [];

      const getTrend = (candles: Candle[]) => {
        if (candles.length < 5) return 'NEUTRAL';
        const last = candles[0];
        const prev = candles[4]; // 5 candles ago
        return last.close > prev.close ? 'BULL' : 'BEAR';
      };

      const m15Trend = getTrend(m15Chart);
      const h1Trend = getTrend(h1Chart);

      // Sort chart: index 0 is CURRENT candle, index 1 is LAST CLOSED candle
      const sortedChart = [...m5Chart].sort((a, b) => b.x - a.x);
      const currentCandle = sortedChart[0]; 
      const lastClosed = sortedChart[1];
      const prevClosed = sortedChart[2];
      
      const isBullishTrend = fastEMA > slowEMA;
      const isBearishTrend = fastEMA < slowEMA;

      // --- CANDLESTICK BIBLE PATTERNS ---
      const bodySize = Math.abs(lastClosed.close - lastClosed.open);
      const upperWick = lastClosed.high - Math.max(lastClosed.open, lastClosed.close);
      const lowerWick = Math.min(lastClosed.open, lastClosed.close) - lastClosed.low;

      const isPinBarBullish = lowerWick > bodySize * 2 && upperWick < bodySize;
      const isPinBarBearish = upperWick > bodySize * 2 && lowerWick < bodySize;
      const isEngulfingBullish = lastClosed.close > lastClosed.open && lastClosed.close > prevClosed.high && lastClosed.open < prevClosed.low;
      const isEngulfingBearish = lastClosed.close < lastClosed.open && lastClosed.close < prevClosed.low && lastClosed.open > prevClosed.high;

      // --- LIQUIDITY SWEEP DETECTION (Lookback 20) ---
      const recentHigh = Math.max(...sortedChart.slice(2, 20).map(c => c.high));
      const recentLow = Math.min(...sortedChart.slice(2, 20).map(c => c.low));
      const sweptHigh = currentCandle.high > recentHigh && price < recentHigh;
      const sweptLow = currentCandle.low < recentLow && price > recentLow;

      // --- FVG (FAIR VALUE GAP) DETECTION ---
      const isFVGBullish = sortedChart[1].low > sortedChart[3].high;
      const isFVGBearish = sortedChart[1].high < sortedChart[3].low;
      const priceInBullFVG = isFVGBullish && price > sortedChart[3].high && price < sortedChart[1].low;
      const priceInBearFVG = isFVGBearish && price < sortedChart[3].low && price > sortedChart[1].high;

      // --- ASIA RANGE & JUDAS SWING ---
      const asiaHigh = Math.max(...sortedChart.filter(c => {
        const d = new Date(c.timestamp * 1000);
        return d.getUTCHours() >= 0 && d.getUTCHours() < 6;
      }).map(c => c.high));
      const asiaLow = Math.min(...sortedChart.filter(c => {
        const d = new Date(c.timestamp * 1000);
        return d.getUTCHours() >= 0 && d.getUTCHours() < 6;
      }).map(c => c.low));
      
      // Time-of-Day Check
      const nowTime = new Date();
      const hour = nowTime.getUTCHours();
      const isKillzone = (hour >= 7 && hour <= 10) || (hour >= 13 && hour <= 16); 
      
      const isJudasSwingBullish = hour >= 7 && hour <= 9 && sweptLow && price > asiaLow;
      const isJudasSwingBearish = hour >= 7 && hour <= 9 && sweptHigh && price < asiaHigh;

      let signal: 'BUY' | 'SELL' | 'NONE' = 'NONE';
      let statusMessage = "";

      const timeAllowed = !botSettings.playbookTimeFilter || isKillzone;

      if (!timeAllowed) {
        statusMessage = "🔍 Outside Gold Killzone. Waiting for London (07:00) or NY (13:00) UTC...";
      } else {
        // --- THE "SUPER SETUP" LOGIC (Diversity of Triggers) ---
        
        // SETUP 1: JUDAS SWING (London Open Reversal)
        if (isJudasSwingBearish && (isEngulfingBearish || isPinBarBearish)) {
          signal = 'SELL';
          statusMessage = "🎯 SUPER SETUP: Judas Swing + Candle Confirmation (Playbook v9)";
        } else if (isJudasSwingBullish && (isEngulfingBullish || isPinBarBullish)) {
          signal = 'BUY';
          statusMessage = "🎯 SUPER SETUP: Judas Swing + Candle Confirmation (Playbook v9)";
        }
        // SETUP 2: MULTI-TIMEFRAME MOMENTUM (Swing & Quantitative)
        else if (h1Trend === 'BULL' && m15Trend === 'BULL' && isBullishTrend && isEngulfingBullish) {
          signal = 'BUY';
          statusMessage = "🎯 SUPER SETUP: Triple Timeframe Momentum Alignment (Swing Trading)";
        } else if (h1Trend === 'BEAR' && m15Trend === 'BEAR' && isBearishTrend && isEngulfingBearish) {
          signal = 'SELL';
          statusMessage = "🎯 SUPER SETUP: Triple Timeframe Momentum Alignment (Swing Trading)";
        }
        // SETUP 3: FVG RETEST (Smart Money Entry)
        else if (priceInBullFVG && isPinBarBullish) {
          signal = 'BUY';
          statusMessage = "🎯 SUPER SETUP: FVG Retest + Pin Bar Rejection (SMC)";
        } else if (priceInBearFVG && isPinBarBearish) {
          signal = 'SELL';
          statusMessage = "🎯 SUPER SETUP: FVG Retest + Pin Bar Rejection (SMC)";
        }
        // SETUP 4: LIQUIDITY SWEEP REVERSAL
        else if (sweptHigh && isEngulfingBearish) {
          signal = 'SELL';
          statusMessage = "🎯 SUPER SETUP: Liquidity Sweep + Engulfing (Quantitative)";
        } else if (sweptLow && isEngulfingBullish) {
          signal = 'BUY';
          statusMessage = "🎯 SUPER SETUP: Liquidity Sweep + Engulfing (Quantitative)";
        }
        // SETUP 5: AGGRESSIVE TREND CONTINUATION (No setup waiting)
        else if (isBullishTrend && isEngulfingBullish && price > currentCandle.open) {
          signal = 'BUY';
          statusMessage = "🚀 AGGRESSIVE: Bullish Trend Continuation (Engulfing Momentum)";
        } else if (isBearishTrend && isEngulfingBearish && price < currentCandle.open) {
          signal = 'SELL';
          statusMessage = "🚀 AGGRESSIVE: Bearish Trend Continuation (Engulfing Momentum)";
        }
        // SETUP 6: FVG/OB RE-ENTRY
        else if (isBullishTrend && priceInBullFVG) {
          signal = 'BUY';
          statusMessage = "🚀 AGGRESSIVE: Bullish FVG Retest Re-entry";
        } else if (isBearishTrend && priceInBearFVG) {
          signal = 'SELL';
          statusMessage = "🚀 AGGRESSIVE: Bearish FVG Retest Re-entry";
        }
        // DEFAULT: TREND FOLLOW
        else if (isBullishTrend && lastClosed.close > lastClosed.open && price > currentCandle.open) {
          signal = 'BUY';
          statusMessage = "🔍 Trend: Bullish. Entering on momentum...";
        } else if (isBearishTrend && lastClosed.close < lastClosed.open && price < currentCandle.open) {
          signal = 'SELL';
          statusMessage = "🔍 Trend: Bearish. Entering on momentum...";
        }
      }

      // Log Status every 30 seconds
      const now = Date.now();
      if (statusMessage) {
        setLastSignalReason(statusMessage);
        if (now - lastLogTimeRef.current > 30000) {
          lastLogTimeRef.current = now;
          addLog({
            level: 'info',
            message: statusMessage,
            timestamp: new Date().toISOString()
          });
        }
      }

      // Execute Trade Logic (Monetary Scale-In Aware)
      if (signal !== 'NONE' && (now - lastTradeTimeRef.current > 30000)) {
        const level1Trailing = openOrders.filter((p: any) => (p.pnl || p.profit) >= 1.00);
        const level2Trailing = openOrders.filter((p: any) => (p.pnl || p.profit) >= 2.00);
        const level3Trailing = openOrders.filter((p: any) => (p.pnl || p.profit) >= 3.00);

        // Logic (Looping Aggressive Scale):
        // 1. First trade: Always open.
        // 2. Scale 1: Only if ALL current trades are trailing >= $1.00.
        // 3. Scale 2 (Aggressive): If any trade hits $2.00, add 2 more.
        // 4. Scale 3 (Loop): If any trade hits $3.00, add another 2.
        
        let canOpen = totalOpen === 0 || level1Trailing.length === totalOpen;
        let numToOpen = 1;

        if (level3Trailing.length > 0) {
          canOpen = true;
          numToOpen = 2; // Loop Scale
        } else if (level2Trailing.length > 0) {
          canOpen = true;
          numToOpen = 2; // Aggressive scale-in
        }

        if (canOpen && totalOpen < dynamicMaxTrades) {
          lastTradeTimeRef.current = now;
          addLog({
            level: 'success',
            message: `🚀 ${numToOpen > 1 ? 'AGGRESSIVE ' : ''}SIGNAL: ${signal} | Adding ${numToOpen} trade(s) | Open: ${totalOpen}/${dynamicMaxTrades}`,
            timestamp: new Date().toISOString()
          });

          for (let i = 0; i < numToOpen; i++) {
            if (totalOpen + i < dynamicMaxTrades) {
              placeOrder({
                symbol: accountData.symbol || accountData.ea_symbol || 'XAUUSD',
                type: signal,
                lots: 0.01,
                sl: 0,
                tp: 0
              }).catch(e => console.error("App brain trade execution failed:", e));
            }
          }
        } else if (!canOpen) {
          // Log why we aren't opening more
          if (now - lastLogTimeRef.current > 30000) {
            lastLogTimeRef.current = now;
            addLog({
              level: 'info',
              message: `🔍 Waiting for trades to hit $1.00 profit before scaling in...`,
              timestamp: new Date().toISOString()
            });
          }
        }
      } else if (signal !== 'NONE' && (now - lastTradeTimeRef.current <= 30000)) {
        // Just log that we are waiting to stagger
        if (now - lastLogTimeRef.current > 30000) {
          addLog({
            level: 'info',
            message: `⏳ Signal ${signal} detected, but waiting 30s to stagger trades...`,
            timestamp: new Date().toISOString()
          });
        }
      } else if (signal !== 'NONE' && totalOpen >= dynamicMaxTrades && (now - lastLogTimeRef.current > 60000)) {
        addLog({
          level: 'warning',
          message: `⚪ Signal ${signal} detected, but Max Trades reached (${totalOpen}/${dynamicMaxTrades})`,
          timestamp: new Date().toISOString()
        });
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
