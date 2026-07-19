import { useState, useEffect, useCallback, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { getAccountData, placeOrder, setBotConfig, closeOrder } from '../api/orders';
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
  
  // Risk Management State
  const trailingStopActive = useRef<Record<string, { activated: boolean, highestProfit: number }>>({});
  const cooldowns = useRef<{ BUY: number, SELL: number }>({ BUY: 0, SELL: 0 });
  const prevPositionsRef = useRef<any[]>([]);

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

      handleAppBrainAnalysis(data);
    });

    return () => {
      socketRef.current?.disconnect();
    };
  }, [serverUrl, setAccountPrice, setAccount]);

  const handleAppBrainAnalysis = useCallback(async (accountData: any) => {
    if (!botSettings.autoTradingEnabled || (botSettings.executionMode || 'app') !== 'app') return;
    
    // --- APP-BASED TRADING BRAIN ---
    const chart = accountData.chart || [];
    const price = Number(accountData.price || 0);
    const fastEMA = Number(accountData.ema20 || accountData.fastEMA || 0);
    const slowEMA = Number(accountData.ema50 || accountData.slowEMA || 0);
    const equity = Number(accountData.equity || 1000);
    const openOrders = accountData.positions || [];
    const symbol = accountData.symbol || accountData.ea_symbol || 'XAUUSD';

    // --- 1. TRACK CLOSED TRADES FOR COOLDOWNS ---
    const currentTickets = openOrders.map((p: any) => String(p.ticket));
    const closedPositions = prevPositionsRef.current.filter(p => !currentTickets.includes(String(p.ticket)));
    
    closedPositions.forEach(p => {
      const profit = Number(p.profit || p.pnl || 0);
      if (profit < 0) {
        const direction = (p.type === 'BUY' || p.type === 0) ? 'BUY' : 'SELL';
        const now = Date.now();
        // If already in cooldown, extend it. Otherwise set to 5 mins.
        const currentCooldown = cooldowns.current[direction];
        const baseCooldown = 5 * 60 * 1000;
        cooldowns.current[direction] = Math.max(now, currentCooldown) + baseCooldown;
        
        addLog({
          level: 'warning',
          message: `📉 Loss detected on ${direction} (${profit}). Cooldown active until ${new Date(cooldowns.current[direction]).toLocaleTimeString()}`,
          timestamp: new Date().toISOString()
        });
      }
      // Cleanup trailing stop state
      delete trailingStopActive.current[String(p.ticket)];
    });
    prevPositionsRef.current = openOrders;

    // --- 2. SWING TRADING: TP & DYNAMIC 50% TRAILING STOP ---
    const TP_LEVELS = [5.00, 10.00, 20.00];

    for (const pos of openOrders) {
      const ticket = String(pos.ticket);
      const profit = Number(pos.profit || pos.pnl || 0);
      
      // 3-Step TP (Closing partial or full at milestones)
      // Since we are adding trades, we treat the $20 as the ultimate target
      if (profit >= TP_LEVELS[2]) {
        addLog({ level: 'success', message: `🏆 SWING TARGET HIT: $${profit} on ticket ${ticket}. Closing...`, timestamp: new Date().toISOString() });
        closeOrder(ticket).catch(console.error);
        continue;
      }

      // Dynamic 50% Profit Trailing Stop (Every $2 gained)
      let exitThreshold = -Infinity;
      
      if (profit >= 2.00) {
        // Calculation: Lock 50% of the current profit
        // Every $2 step effectively moves this up
        exitThreshold = profit * 0.50;
      }

      if (exitThreshold !== -Infinity && profit < exitThreshold) {
        addLog({ level: 'warning', message: `🛡️ SWING TS (50%): $${profit} (Locked: $${exitThreshold.toFixed(2)}) on ticket ${ticket}. Closing...`, timestamp: new Date().toISOString() });
        closeOrder(ticket).catch(console.error);
      }
    }

    // --- 3. SWING SCALE-IN LOGIC ---
    // Add one more trade with each $2 profit gained on the aggregate or individual trades
    const dynamicMaxTrades = Math.max(5, Math.min(15, Math.floor(equity / 1000)));
    const totalOpen = openOrders.length;

    let m5Chart: Candle[] = [];
    if (typeof chart === 'object' && !Array.isArray(chart)) {
      m5Chart = chart['M5'] || [];
    } else if (Array.isArray(chart)) {
      m5Chart = chart;
    }

    if (fastEMA > 0 && slowEMA > 0 && m5Chart.length >= 40) {
      // --- 3. REGIME FILTERS ---
      const m15Chart: Candle[] = accountData.chart?.['M15'] || [];
      const h1Chart: Candle[] = accountData.chart?.['H1'] || [];
      
      const sortedM5 = [...m5Chart].sort((a, b) => b.x - a.x);
      const sortedM15 = [...m15Chart].sort((a, b) => b.x - a.x);
      const sortedH1 = [...h1Chart].sort((a, b) => b.x - a.x);

      // Filter: Consecutively bullish candles (3 higher closes)
      const isConsecBullishM5 = sortedM5.length >= 3 && 
        sortedM5[1].close > sortedM5[2].close && 
        sortedM5[2].close > sortedM5[3].close;
      
      const isConsecBullishM15 = sortedM15.length >= 3 && 
        sortedM15[1].close > sortedM15[2].close && 
        sortedM15[2].close > sortedM15[3].close;

      const isConsecBearishM5 = sortedM5.length >= 3 && 
        sortedM5[1].close < sortedM5[2].close && 
        sortedM5[2].close < sortedM5[3].close;
      
      const isConsecBearishM15 = sortedM15.length >= 3 && 
        sortedM15[1].close < sortedM15[2].close && 
        sortedM15[2].close < sortedM15[3].close;

      const blockSellEntries = isConsecBullishM5 || isConsecBullishM15;
      const blockBuyEntries = isConsecBearishM5 || isConsecBearishM15;

      // NEW: Smart Momentum Filter (Net change over last 5 candles)
      const getNetMomentum = (candles: Candle[]) => {
        if (candles.length < 6) return 0;
        const last5 = candles.slice(1, 6);
        const bullSize = last5.reduce((sum, c) => sum + (c.close > c.open ? c.close - c.open : 0), 0);
        const bearSize = last5.reduce((sum, c) => sum + (c.open > c.close ? c.open - c.close : 0), 0);
        return bullSize - bearSize;
      };

      const m5NetMomentum = getNetMomentum(sortedM5);
      const isStrongBullishMomentum = m5NetMomentum > (currentATR * 2); 
      const isStrongBearishMomentum = m5NetMomentum < -(currentATR * 2);

      // Filter: ATR Volatility (ATR14 > 1.5x its 20-period average)
      const calculateATR = (candles: Candle[], period: number) => {
        if (candles.length <= period) return 0;
        const trs = candles.map((c, i) => {
          if (i === candles.length - 1) return c.high - c.low;
          const prev = candles[i + 1];
          return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
        });
        return trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
      };

      const currentATR = calculateATR(sortedM5, 14);
      const atrHistory: number[] = [];
      for (let i = 0; i < 20; i++) {
        const slice = sortedM5.slice(i);
        if (slice.length >= 14) atrHistory.push(calculateATR(slice, 14));
      }
      const atrAvg20 = atrHistory.length > 0 ? atrHistory.reduce((a, b) => a + b, 0) / atrHistory.length : currentATR;
      const blockAllEntries = currentATR > (atrAvg20 * 1.5);

      // Filter: 4h Structure
      const high4h = (sortedH1.length >= 5) ? Math.max(...sortedH1.slice(1, 5).map(c => c.high)) : Infinity;
      const low4h = (sortedH1.length >= 5) ? Math.min(...sortedH1.slice(1, 5).map(c => c.low)) : -Infinity;
      
      const isMakingHH4h = price > high4h && high4h !== Infinity;
      const isMakingLL4h = price < low4h && low4h !== -Infinity;

      const suppressSellSignals = isMakingHH4h;
      const suppressBuySignals = isMakingLL4h;

      // --- 4. EXPOSURE CAP ---
      const totalLots = openOrders.reduce((sum: number, p: any) => sum + (Number(p.volume || p.lots || 0)), 0);
      const EXPOSURE_CAP = 1.5;
      const isExposureCapReached = totalLots >= EXPOSURE_CAP;

      // --- MULTI-TIMEFRAME ANALYSIS (Swing & Momentum) ---
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

      // --- LIQUIDITY SWEEP DETECTION (Live Current Candle Wicks) ---
      // Triggered immediately when current candle sweeps previous high/low
      const sweptHigh = currentCandle.high > lastClosed.high && price < lastClosed.high;
      const sweptLow = currentCandle.low < lastClosed.low && price > lastClosed.low;

      // --- FVG (FAIR VALUE GAP) DETECTION ---
      // Bullish FVG: Candle 3 High < Candle 1 Low (Gap between C1 High and C3 Low)
      const isFVGBullish = sortedChart[3].high < sortedChart[1].low;
      // Bearish FVG: Candle 3 Low > Candle 1 High (Gap between C3 High and C1 Low)
      const isFVGBearish = sortedChart[3].low > sortedChart[1].high;
      
      const priceInBullFVG = isFVGBullish && price > sortedChart[1].high && price < sortedChart[3].low;
      const priceInBearFVG = isFVGBearish && price < sortedChart[1].low && price > sortedChart[3].high;

      let signalSL = 0;
      const SL_OFFSET = 0.10; // 10 points on Gold

      // --- ASIA RANGE & JUDAS SWING (Live Detection) ---
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
      
      const isJudasSwingBullish = hour >= 7 && hour <= 9 && currentCandle.low < asiaLow && price > asiaLow;
      const isJudasSwingBearish = hour >= 7 && hour <= 9 && currentCandle.high > asiaHigh && price < asiaHigh;

      let signal: 'BUY' | 'SELL' | 'NONE' = 'NONE';
      let statusMessage = "";

      const timeAllowed = !botSettings.playbookTimeFilter || isKillzone;

      // --- CHASE PROTECTION: Max 30 points from current candle open ---
      const CHASE_LIMIT = 0.30; // 30 points (3 pips) on Gold
      const pointsFromOpen = Math.abs(price - currentCandle.open);
      const isChasing = pointsFromOpen > CHASE_LIMIT;

      if (!timeAllowed) {
        statusMessage = "🔍 Outside Gold Killzone. Waiting for London (07:00) or NY (13:00) UTC...";
      } else if (blockAllEntries) {
        statusMessage = "⚠️ VOLATILITY SPIKE: ATR (14) exceeds 1.5x average. Blocking all entries.";
      } else {
        // --- THE "SUPER SETUP" LOGIC ---
        // SETUP 1: JUDAS SWING (Live Reversal at Asia Range Boundary)
        if (isJudasSwingBearish && !isChasing) {
          signal = 'SELL';
          statusMessage = "🎯 SUPER SETUP: Judas Swing Live Reversal (Asia High Sweep)";
        } else if (isJudasSwingBullish && !isChasing) {
          signal = 'BUY';
          statusMessage = "🎯 SUPER SETUP: Judas Swing Live Reversal (Asia Low Sweep)";
        }
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
          signalSL = sortedChart[1].high - SL_OFFSET; // 10 points below FVG bottom
          statusMessage = `🎯 SUPER SETUP: FVG Retest + Pin Bar (SL: ${signalSL.toFixed(2)})`;
        } else if (priceInBearFVG && isPinBarBearish) {
          signal = 'SELL';
          signalSL = sortedChart[1].low + SL_OFFSET; // 10 points above FVG top
          statusMessage = `🎯 SUPER SETUP: FVG Retest + Pin Bar (SL: ${signalSL.toFixed(2)})`;
        }
        // SETUP 4: LIQUIDITY SWEEP REVERSAL (Live Current Candle)
        else if (sweptHigh && !isChasing) {
          signal = 'SELL';
          statusMessage = "🎯 SUPER SETUP: Live Liquidity Sweep (Prev High)";
        } else if (sweptLow && !isChasing) {
          signal = 'BUY';
          statusMessage = "🎯 SUPER SETUP: Live Liquidity Sweep (Prev Low)";
        }
        else if (isBullishTrend && isEngulfingBullish && price > currentCandle.open) {
          signal = 'BUY';
          statusMessage = "🚀 AGGRESSIVE: Bullish Trend Continuation (Momentum)";
        } else if (isBearishTrend && isEngulfingBearish && price < currentCandle.open) {
          signal = 'SELL';
          statusMessage = "🚀 AGGRESSIVE: Bearish Trend Continuation (Momentum)";
        }
        else if (isBullishTrend && priceInBullFVG) {
          signal = 'BUY';
          statusMessage = "🚀 AGGRESSIVE: Bullish FVG Retest Re-entry";
        } else if (isBearishTrend && priceInBearFVG) {
          signal = 'SELL';
          statusMessage = "🚀 AGGRESSIVE: Bearish FVG Retest Re-entry";
        }
        else if (isBullishTrend && lastClosed.close > lastClosed.open && price > currentCandle.open) {
          signal = 'BUY';
          statusMessage = "🔍 Trend: Bullish. Entering on momentum...";
        } else if (isBearishTrend && lastClosed.close < lastClosed.open && price < currentCandle.open) {
          signal = 'SELL';
          statusMessage = "🔍 Trend: Bearish. Entering on momentum...";
        }

        // --- NEW: DIAGNOSTIC SEARCHING STATUS ---
        if (signal === 'NONE' && !statusMessage) {
          const trendStr = isBullishTrend ? "BULL" : (isBearishTrend ? "BEAR" : "NEUTRAL");
          const fvgStr = isFVGBullish ? "FVG Bullish" : (isFVGBearish ? "FVG Bearish" : "No FVG");
          const killzoneStr = isKillzone ? "In Killzone" : "Outside Killzone";
          const atrRatio = atrAvg20 > 0 ? (currentATR / atrAvg20).toFixed(2) : "0.00";
          const hhInfo = high4h !== Infinity ? ` | 4hH: ${high4h.toFixed(2)}` : "";
          const swingInfo = ` | SWING: [Next: $${(totalOpen + 1) * 2}]`;
          statusMessage = `Searching... [${trendStr} | ${fvgStr} | ${killzoneStr} | ATR: ${atrRatio}x${hhInfo}${swingInfo}]`;
        }

        if (signal === 'SELL') {
          if (blockSellEntries) {
            signal = 'NONE';
            statusMessage = "🛡️ REGIME FILTER: 3 Bullish Candles on M5/M15. SELL blocked.";
          } else if (suppressSellSignals) {
            signal = 'NONE';
            statusMessage = "🛡️ REGIME FILTER: Price making 4h HH. SELL suppressed.";
          } else if (isStrongBullishMomentum) {
            signal = 'NONE';
            statusMessage = "🛡️ MOMENTUM FILTER: Strong Bullish flow detected. SELL blocked.";
          } else if (price > fastEMA) {
            signal = 'NONE';
            statusMessage = "🛡️ PRICE ACTION: Price above EMA20. SELL suppressed.";
          }
        }

        if (signal === 'BUY') {
          if (blockBuyEntries) {
            signal = 'NONE';
            statusMessage = "🛡️ REGIME FILTER: 3 Bearish Candles on M5/M15. BUY blocked.";
          } else if (suppressBuySignals) {
            signal = 'NONE';
            statusMessage = "🛡️ REGIME FILTER: Price making 4h LL. BUY suppressed.";
          } else if (isStrongBearishMomentum) {
            signal = 'NONE';
            statusMessage = "🛡️ MOMENTUM FILTER: Strong Bearish flow detected. BUY blocked.";
          } else if (price < fastEMA) {
            signal = 'NONE';
            statusMessage = "🛡️ PRICE ACTION: Price below EMA20. BUY suppressed.";
          }
        }
      }

      const now = Date.now();
      if (statusMessage) {
        setLastSignalReason(statusMessage);
        // Only log to persistent logs if it's an actual signal or every 60s for "Searching"
        const isActualSignal = signal !== 'NONE' && !statusMessage.startsWith('Searching');
        const logInterval = isActualSignal ? 30000 : 60000;
        
        if (now - lastLogTimeRef.current > logInterval) {
          lastLogTimeRef.current = now;
          addLog({ level: 'info', message: statusMessage, timestamp: new Date().toISOString() });
        }
      }

      if (signal !== 'NONE' && (now - lastTradeTimeRef.current > 30000)) {
        const nowAtExecution = Date.now();
        if (nowAtExecution < cooldowns.current[signal as 'BUY' | 'SELL']) {
          const remaining = Math.ceil((cooldowns.current[signal as 'BUY' | 'SELL'] - nowAtExecution) / 1000);
          if (nowAtExecution - lastLogTimeRef.current > 30000) {
            addLog({ level: 'info', message: `⏳ Cooldown active for ${signal}. ${remaining}s remaining...`, timestamp: new Date().toISOString() });
          }
          return;
        }

        if (isExposureCapReached) {
          if (nowAtExecution - lastLogTimeRef.current > 30000) {
            addLog({ level: 'warning', message: `🚫 EXPOSURE CAP REACHED: ${totalLots.toFixed(2)} lots open. Max 1.5 lots.`, timestamp: new Date().toISOString() });
          }
          return;
        }

        // Scale-in rule: Only if ALL trades have at least $2 profit (securing 50% lock)
        const tradesReadyToScale = openOrders.filter((p: any) => (p.pnl || p.profit) >= 2.00);
        
        // We also track how many $2 "milestones" we've hit to decide if we add more
        const maxProfit = openOrders.length > 0 ? Math.max(...openOrders.map((p: any) => Number(p.pnl || p.profit || 0))) : 0;
        const milestoneCount = Math.floor(maxProfit / 2); // 1 at $2, 2 at $4, etc.
        
        let canOpen = totalOpen === 0 || (totalOpen < dynamicMaxTrades && tradesReadyToScale.length === totalOpen && totalOpen <= milestoneCount);
        let numToOpen = 1;

        if (canOpen) {
          lastTradeTimeRef.current = now;
          const scaleType = numToOpen > 1 ? 'AGGRESSIVE SCALE' : (totalOpen === 0 ? 'INITIAL' : 'SCALE');
          addLog({
            level: 'success',
            message: `🚀 ${scaleType} SIGNAL: ${signal} | Adding ${numToOpen} trade(s) | Open: ${totalOpen}/${dynamicMaxTrades}`,
            timestamp: new Date().toISOString()
          });

          for (let i = 0; i < numToOpen; i++) {
            if (totalOpen + i < dynamicMaxTrades) {
              placeOrder({
                symbol: accountData.symbol || accountData.ea_symbol || 'XAUUSD',
                type: signal,
                lots: 0.01,
                sl: signalSL,
                tp: 0
              }).catch(e => console.error("App brain trade execution failed:", e));
            }
          }
        } else if (!canOpen) {
          if (now - lastLogTimeRef.current > 30000) {
            lastLogTimeRef.current = now;
            addLog({ level: 'info', message: `🔍 Waiting for trades to hit $1.00 profit before scaling in...`, timestamp: new Date().toISOString() });
          }
        }
      } else if (signal !== 'NONE' && (now - lastTradeTimeRef.current <= 30000)) {
        if (now - lastLogTimeRef.current > 30000) {
          addLog({ level: 'info', message: `⏳ Signal ${signal} detected, but waiting 30s to stagger trades...`, timestamp: new Date().toISOString() });
        }
      } else if (signal !== 'NONE' && totalOpen >= dynamicMaxTrades && (now - lastLogTimeRef.current > 60000)) {
        addLog({ level: 'warning', message: `⚪ Signal ${signal} detected, but Max Trades reached (${totalOpen}/${dynamicMaxTrades})`, timestamp: new Date().toISOString() });
      }
    }
  }, [botSettings, addLog, setLastSignalReason, setAccount, setAccountPrice, setOpenPositions, setError, setLoading]);

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

      if (accountData.ea_connected && prevAutoTrading.current !== botSettings.autoTradingEnabled) {
        prevAutoTrading.current = botSettings.autoTradingEnabled;
        placeOrder({
          symbol: accountData.symbol || 'XAUUSD',
          type: botSettings.autoTradingEnabled ? 'RESUME' : 'PAUSE',
          lots: 0, sl: 0, tp: 0
        }).catch(e => console.error("Auto-trade sync failed:", e));
      }

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
