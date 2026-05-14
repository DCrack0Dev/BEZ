import { useState, useEffect, useCallback, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { getAccountData, placeOrder } from '../api/orders';
import { useTradeStore } from '../store/useTradeStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useLogStore } from '../store/useLogStore';

/**
 * usePolling.ts (Execution Brain)
 * Mobile app's execution brain. Manages real-time WebSocket signals and polling.
 */

// ... (existing interfaces)

export const usePolling = () => {
  const { setAccount, setOpenPositions, setStructures, setError, setLoading, setLastSignalReason, setKeyLevelInfo } = useTradeStore();
  const { botSettings } = useSettingsStore();
  const { addLog, setKeyLevelDistance } = useLogStore();
  
  const socketRef = useRef<Socket | null>(null);
  
  // Initialize WebSocket for real-time signals and stop updates
  useEffect(() => {
    socketRef.current = io('https://liquibot-back.onrender.com');

    // NEW: Real-time Data Relay from EA
    socketRef.current.on('EA_HEARTBEAT', (data) => {
      handleAppBrainAnalysis(data);
    });

    socketRef.current.on('TRADE_SIGNAL', (data) => {
      const { signal, urgency, expiresIn, requiresConfirmation } = data;
      addLog({ 
        level: 'info', 
        message: `🚀 ${urgency} Signal Received: ${signal.symbol} ${signal.direction}`, 
        timestamp: new Date().toISOString() 
      });
      
      // Auto-execute if configured or expires soon
      const isExpired = Date.now() > signal.timestamp + expiresIn * 1000;
      if (!isExpired && (!requiresConfirmation || botSettings.autoTradingEnabled)) {
        handleExecuteSignal(signal);
      } else if (isExpired) {
        addLog({ level: 'warning', message: `⏳ Signal for ${signal.symbol} expired`, timestamp: new Date().toISOString() });
      }
    });

    socketRef.current.on('STOP_UPDATE', (data) => {
      const { positionTicket, newStopLoss, phase, direction, isRiskFree } = data;
      addLog({ 
        level: 'info', 
        message: `🛡️ Phase ${phase} Stop: #${positionTicket} -> ${newStopLoss} ${isRiskFree ? '(RISK FREE)' : ''}`, 
        timestamp: new Date().toISOString() 
      });
      handleModifyStop(positionTicket, newStopLoss);
    });

    socketRef.current.on('SCALEIN_TRIGGER', (data) => {
      const { signalId, level, price, lotSize, newStopLoss, direction, symbol } = data;
      addLog({ 
        level: 'success', 
        message: `➕ Scale-In L${level} Triggered for ${symbol} at ${price}`, 
        timestamp: new Date().toISOString() 
      });
      handleScaleIn(signalId, level, lotSize, newStopLoss, direction, symbol);
    });

    return () => {
      socketRef.current?.disconnect();
    };
  }, []);

  const handleAppBrainAnalysis = useCallback(async (data: any) => {
    if (!botSettings.autoTradingEnabled || (botSettings.executionMode || 'app') !== 'app') return;
    
    // 1. Data Processing
    const price = Number(data.price || 0);
    const m5Chart = data.chart?.['M5'] || data.candles || [];
    if (m5Chart.length < 50) return;

    const atr = Number(data.atr14 || data.atr || 0);
    const spread = Number(data.spread || 0);

    // 2. Key Level Analysis (using 48h data)
    const levels = findKeyLevels(m5Chart);
    const orderBlocks = findOrderBlocks(m5Chart);
    const fvgs = findFVGs(m5Chart);

    // Update UI Key Levels
    const supportLevels = levels.filter(l => l.type === 'SUPPORT').sort((a, b) => b.price - a.price);
    const resistanceLevels = levels.filter(l => l.type === 'RESISTANCE').sort((a, b) => a.price - b.price);
    const nearestSupport = supportLevels.find(l => l.price < price);
    const nearestResistance = resistanceLevels.find(l => l.price > price);

    if (nearestSupport || nearestResistance) {
      const primaryLevel = (nearestSupport && (price - nearestSupport.price < (nearestResistance?.price - price || 9999))) 
        ? nearestSupport 
        : nearestResistance;
      
      if (primaryLevel) {
        const distance = Math.abs(primaryLevel.price - price);
        setKeyLevelInfo({ level: primaryLevel.price, distance, type: primaryLevel.type });
        setKeyLevelDistance(primaryLevel.price, distance, primaryLevel.type);
      }
    }

    // 3. Trend Detection
    const fastEMA = Number(data.ema20 || 0);
    const slowEMA = Number(data.ema20Prev || 0);
    const currentTrend = fastEMA > slowEMA ? 'BULL' : 'BEAR';
    
    // 4. Strategy Logic (SMC: OB + FVG + Reversal)
    let signal: 'BUY' | 'SELL' | 'NONE' = 'NONE';
    const sortedChart = [...m5Chart].sort((a, b) => b.timestamp - a.timestamp);
    const lastCandle = sortedChart[0];
    const prevCandle = sortedChart[1];
    
    const atSupport = nearestSupport && (price - nearestSupport.price) < (atr * 1.5);
    const atResistance = nearestResistance && (nearestResistance.price - price) < (atr * 1.5);

    // BUY: Bullish Reversal at Support/OB/FVG + Trend
    if (currentTrend === 'BULL' && lastCandle.close > lastCandle.open && atSupport) {
      signal = 'BUY';
    } 
    // SELL: Bearish Reversal at Resistance/OB/FVG + Trend
    else if (currentTrend === 'BEAR' && lastCandle.close < lastCandle.open && atResistance) {
      signal = 'SELL';
    }

    if (signal !== 'NONE' && spread <= 30) {
      addLog({ 
        level: 'info', 
        message: `🧠 App Brain Signal: ${signal} ${data.symbol || 'XAUUSD'} @ ${price}`, 
        timestamp: new Date().toISOString() 
      });
      
      const sl = signal === 'BUY' ? (nearestSupport?.price || lastCandle.low) - (atr * 1.2) : (nearestResistance?.price || lastCandle.high) + (atr * 1.2);
      const tp = signal === 'BUY' ? price + (atr * 3) : price - (atr * 3);
      
      handleExecuteSignal({
        symbol: data.symbol || 'XAUUSD',
        direction: signal,
        lotSizes: { entry1: botSettings.defaultLots || 0.01 },
        stopLoss: sl,
        tpLevels: [tp],
        timestamp: Date.now()
      });
    }
  }, [botSettings, addLog, setKeyLevelInfo, setKeyLevelDistance]);

  const handleExecuteSignal = async (signal: any) => {
    try {
      await placeOrder({
        type: signal.direction,
        symbol: signal.symbol,
        lots: signal.lotSizes.entry1,
        sl: signal.stopLoss,
        tp: signal.tpLevels[0]
      });
      addLog({ level: 'success', message: `✅ Entry 1 Executed for ${signal.symbol}`, timestamp: new Date().toISOString() });
    } catch (err) {
      addLog({ level: 'error', message: `❌ Entry 1 Failed: ${err}`, timestamp: new Date().toISOString() });
    }
  };

  const handleModifyStop = async (ticket: string, newSL: number) => {
    try {
      await placeOrder({ action: 'MODIFY_SL', ticket, sl: newSL });
    } catch (err) {
      console.error('Stop update failed', err);
    }
  };

  const handleScaleIn = async (signalId: string, level: number, lots: number, sl: number, direction: string, symbol: string) => {
    try {
      // 1. Open scale-in position
      await placeOrder({
        type: direction,
        symbol: symbol,
        lots: lots,
        sl: sl
      });
      addLog({ level: 'success', message: `✅ Scale-In L${level} Executed for ${symbol}`, timestamp: new Date().toISOString() });
    } catch (err) {
      addLog({ level: 'error', message: `❌ Scale-In Failed: ${err}`, timestamp: new Date().toISOString() });
    }
  };

  const refresh = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      // Use getAccountData to fetch everything in one go (it includes positions)
      const accountData = await getAccountData();
      if (!accountData) {
        throw new Error('No data received from server');
      }

      const openOrders = accountData.positions || [];
      
      // Process chart data safely
      let safeChart = [];
      try {
        if (accountData.chart && typeof accountData.chart === 'object') {
          safeChart = accountData.chart;
        }
      } catch (error) {
        console.error('[POLLING] Error processing chart data:', error);
        safeChart = [];
      }
      
      const balance = Number(accountData.balance || 0);
      const pnlToday = Number(accountData.pnl_today || accountData.pnlToday || 0);
      
      const accountDataSafe = {
        balance,
        equity: Number(accountData.equity || 0),
        pnlToday,
        eaConnected: accountData.ea_connected || accountData.eaConnected || false,
        eaSymbol: accountData.symbol || accountData.eaSymbol || accountData.ea_symbol || 'XAUUSD',
        price: Number(accountData.price || 0),
        fastEMA: Number(accountData.ema20 || 0),
        slowEMA: Number(accountData.ema20Prev || 0),
        bbUpper: Number(accountData.bbUpper || 0),
        bbLower: Number(accountData.bbLower || 0),
        rsi: Number(accountData.rsi || 0),
        atr: Number(accountData.atr14 || accountData.atr || 0),
        vwap: Number(accountData.vwap || 0),
        spread: Number(accountData.spread || 0),
        tickVolume: Number(accountData.tickVolume || 0),
        currency: accountData.currency || 'USD',
        chart: safeChart,
        keyLevelInfo: accountData.keyLevelInfo,
        logs: accountData.logs,
      };
      
      setAccount(accountDataSafe);
      
      // Map open orders to the Position interface
      const mappedPositions = openOrders.map((pos: any) => ({
        ticket: String(pos.ticket),
        symbol: pos.symbol,
        type: pos.type,
        lots: pos.volume || pos.lots || 0,
        openPrice: pos.openPrice || pos.price || 0,
        currentPrice: accountData.price || pos.price || 0,
        profit: pos.profit || 0,
        pnl: pos.profit || 0,
        openTime: pos.time ? new Date(Number(pos.time) * 1000).toISOString() : new Date().toISOString(),
        sl: Number(pos.sl || 0) || undefined,
        tp: Number(pos.tp || 0) || undefined,
      }));

      setOpenPositions(mappedPositions);
       setStructures(accountData.structures || {});
       setError(null);

       // Update key level distance from backend data if available
        if (accountData.keyLevelInfo) {
          setKeyLevelDistance(
            accountData.keyLevelInfo.level,
            accountData.keyLevelInfo.distance,
            accountData.keyLevelInfo.type
          );
        }

        // Process incoming logs from EA/Backend
        if (Array.isArray(accountData.logs)) {
          accountData.logs.forEach((incomingLog: any) => {
            // Only add if not already in existing logs (based on message and timestamp)
            const exists = existingLogs.some(l => 
              l.message === incomingLog.message && 
              l.component === incomingLog.component
            );
            if (!exists) {
              addLog({
                component: incomingLog.component,
                level: incomingLog.level,
                message: incomingLog.message,
                details: incomingLog.details
              });
            }
          });
        }
 
       // Sync bot settings
       if (accountDataSafe.eaConnected) {
         const autoTradingChanged = prevAutoTrading.current !== botSettings.autoTradingEnabled;
         const executionModeChanged = prevExecutionMode.current !== (botSettings.executionMode || 'app');
         if (!autoTradingSyncSentRef.current || autoTradingChanged || executionModeChanged) {
           prevAutoTrading.current = botSettings.autoTradingEnabled;
           prevExecutionMode.current = botSettings.executionMode || 'app';
           autoTradingSyncSentRef.current = true;
           placeOrder({
             symbol: accountDataSafe.eaSymbol || 'BTCUSD',
             type: botSettings.autoTradingEnabled ? 'RESUME' : 'PAUSE',
             lots: 0, sl: 0, tp: 0
           }).catch(e => console.error("Auto-trade sync failed:", e));
           setBotConfig({
             autoTradingEnabled: botSettings.autoTradingEnabled,
             executionMode: botSettings.executionMode || 'app',
             defaultLots: botSettings.defaultLots,
             maxOpenTrades: botSettings.maxOpenTrades,
             trailingStopEnabled: botSettings.trailingStopEnabled,
           }).catch(e => console.error("Bot config sync failed:", e));
         }
       } else {
         autoTradingSyncSentRef.current = false;
       }
  
       // Daily loss limit
       const dailyLossLimit = balance * 0.03;
       if (pnlToday <= -dailyLossLimit) {
         console.log('🛑 Daily drawdown limit reached');
         return;
       }
      
      // --- PURE SMC APP BRAIN ---
      if (botSettings.autoTradingEnabled && accountDataSafe.eaConnected && (botSettings.executionMode || 'app') === 'app') {
        let chart = [];
        let m1Chart = [];
        let h1Chart = [];
        let m15Chart = [];
        let h4Chart = [];
        
        if (accountData.chart) {
          if (Array.isArray(accountData.chart)) {
            chart = accountData.chart;
          } else {
            chart = accountData.chart['M5'] || accountData.chart['M1'] || [];
            m1Chart = accountData.chart['M1'] || [];
            h1Chart = accountData.chart['H1'] || [];
            m15Chart = accountData.chart['M15'] || [];
            h4Chart = accountData.chart['H4'] || [];
          }
        }
        
        const price = accountData.price || 0;
        const atr = accountData.atr || 0;
        const spreadRaw = accountData.spread || 0;
        const inferredPoint = price >= 1000 ? 0.001 : (price >= 100 ? 0.01 : 0.0001);
        const spread = spreadRaw > Math.max(atr * 8, 10) ? spreadRaw * inferredPoint : spreadRaw;
        const fastEMA = accountData.fastEMA || 0;
        const slowEMA = accountData.slowEMA || 0;
        
        if (atr > 0 && chart.length >= 10) {
          const sortedChart = [...chart].sort((a, b) => b.x - a.x);
          const sortedM1 = m1Chart.length > 0 ? [...m1Chart].sort((a, b) => b.x - a.x) : [];
          const sortedH1 = h1Chart.length > 0 ? [...h1Chart].sort((a, b) => b.x - a.x) : [];
          const sortedM15 = m15Chart.length > 0 ? [...m15Chart].sort((a, b) => b.x - a.x) : [];
          const sortedH4 = h4Chart.length > 0 ? [...h4Chart].sort((a, b) => b.x - a.x) : [];

          // Detect freshly closed positions from open-order transitions and tag SL/TP exits.
          const previousOpen = prevOpenOrdersRef.current || [];
          const currentTickets = new Set((openOrders || []).map((p: any) => String(p.ticket)));
          const closedNow = previousOpen
            .filter((p: any) => !currentTickets.has(String(p.ticket)))
            .sort((a: any, b: any) => Number(a.time || 0) - Number(b.time || 0));

          if (closedNow.length > 0) {
            const closed = closedNow[closedNow.length - 1];
            const side: 'BUY' | 'SELL' = (String(closed.type).toUpperCase() === 'SELL') ? 'SELL' : 'BUY';
            const sl = Number(closed.sl || 0);
            const tp = Number(closed.tp || 0);
            const closeBuffer = atr * 0.15;
            let reason: 'SL' | 'TP' | null = null;

            if (side === 'BUY') {
              if (sl > 0 && price <= (sl + closeBuffer)) reason = 'SL';
              else if (tp > 0 && price >= (tp - closeBuffer)) reason = 'TP';
            } else {
              if (sl > 0 && price >= (sl - closeBuffer)) reason = 'SL';
              else if (tp > 0 && price <= (tp + closeBuffer)) reason = 'TP';
            }

            if (reason) {
              lastExitEventRef.current = {
                ticket: String(closed.ticket || ''),
                side,
                reason,
                ts: Date.now(),
                consumed: false,
              };
              console.log(`🧭 Exit tracked: #${closed.ticket} ${side} ${reason}`);
            }
          }
          
          let signal: 'BUY' | 'SELL' | 'NONE' | 'CLOSE_ALL' = 'NONE';
          let slPrice = 0;
          let tpPrice = 0;
          let signalReason = '';
          
          const totalOpen = openOrders.length;
          const maxOpenTrades = Math.max(1, botSettings.maxOpenTrades || 1);
          const now = Date.now();
          
          // Trailing Stop & Stacking Logic
          if (totalOpen > 0) {
            openOrders.forEach(pos => {
              const profit = pos.profit || 0;
              const isBuy = pos.type === 'BUY';
              const chartAsc = [...sortedChart].sort((a, b) => a.x - b.x);
              const canTrailAfterSecondClose = (() => {
                if (chartAsc.length < 4) return false;
                const openTime = Number(pos.time || 0);
                if (!openTime) return false;

                const inferredTfSec =
                  chartAsc.length >= 2
                    ? Math.max(60, Math.abs(Number(chartAsc[1].x) - Number(chartAsc[0].x)) || 300)
                    : 300;

                const entryIdx = chartAsc.findIndex((c) => {
                  const t = Number(c.x);
                  return t <= openTime && openTime < (t + inferredTfSec);
                });
                if (entryIdx < 0) return false;

                const secondAfterEntryIdx = entryIdx + 2;
                const lastClosedIdx = chartAsc.length - 2; // last bar may still be forming
                if (secondAfterEntryIdx > lastClosedIdx) return false;

                const entryClose = Number(chartAsc[entryIdx].close);
                const secondClose = Number(chartAsc[secondAfterEntryIdx].close);
                if (!Number.isFinite(entryClose) || !Number.isFinite(secondClose)) return false;

                return isBuy ? secondClose > entryClose : secondClose < entryClose;
              })();
              
              // Emergency Manual Close
              const closeBuffer = atr * 0.1;
              if (pos.tp > 0 && ((isBuy && price >= pos.tp - closeBuffer) || (!isBuy && price <= pos.tp + closeBuffer))) {
                console.log(`🚨 Emergency TP Close for #${pos.ticket}`);
                placeOrder({ symbol: accountDataSafe.eaSymbol, type: 'CLOSE_ALL', lots: 0, sl: 0, tp: 0 }).catch(() => {});
              }
              if (pos.sl > 0 && ((isBuy && price <= pos.sl + closeBuffer) || (!isBuy && price >= pos.sl - closeBuffer))) {
                console.log(`🚨 Emergency SL Close for #${pos.ticket}`);
                placeOrder({ symbol: accountDataSafe.eaSymbol, type: 'CLOSE_ALL', lots: 0, sl: 0, tp: 0 }).catch(() => {});
              }

              // --- IMPROVED TRAILING STOP ($0.50 profit = move to break even, then trail) ---
              if (profit >= 0.50) {
                if (!canTrailAfterSecondClose) {
                  if (Math.random() > 0.85) {
                    console.log(`⏳ Trail blocked for #${pos.ticket}: waiting for 2nd candle close confirmation`);
                  }
                  return;
                }

                const currentSl = pos.sl || 0;
                let newSlPrice = 0;
                
                if (isBuy) {
                  const breakEven = pos.openPrice + (atr * 0.1); // BE + small buffer
                  if (currentSl < breakEven) {
                    newSlPrice = breakEven;
                  } else if (profit >= 1.50) {
                    // Trail by 0.5 ATR behind price
                    const trailSl = price - (atr * 0.5);
                    if (trailSl > currentSl) newSlPrice = trailSl;
                  }
                } else {
                  const breakEven = pos.openPrice - (atr * 0.1);
                  if (currentSl === 0 || currentSl > breakEven) {
                    newSlPrice = breakEven;
                  } else if (profit >= 1.50) {
                    const trailSl = price + (atr * 0.5);
                    if (trailSl < currentSl) newSlPrice = trailSl;
                  }
                }
                
                if (newSlPrice > 0 && Math.abs(newSlPrice - currentSl) > (atr * 0.1)) {
                  placeOrder({
                    symbol: accountData.eaSymbol || 'BTCUSD',
                    type: 'MODIFY_SL',
                    lots: pos.lots,
                    sl: newSlPrice,
                    tp: pos.tp || 0,
                    ticket: pos.ticket
                  }).catch(e => console.error("Trailing update failed:", e));
                }
              }
            });

            // Time exit
            const oldestTrade = openOrders.reduce((oldest, current) => {
              return (current.time || 0) < (oldest.time || 0) ? current : oldest;
            }, openOrders[0]);
            
            if (oldestTrade && oldestTrade.time) {
              const tradeAgeSeconds = Math.floor(Date.now() / 1000) - oldestTrade.time;
              if (tradeAgeSeconds > 900) {
                signal = 'CLOSE_ALL';
              }
            }
          }
          
          // PURE SMC ENTRY LOGIC
          if (signal === 'NONE') {
            const allTrailed = openOrders.every(pos => pos.profit >= 0.50);
            const canStack = totalOpen === 0 || (totalOpen < maxOpenTrades && allTrailed);
            
            if (totalOpen > 0 && !allTrailed) {
              console.log(`⚠️ Stacking blocked: waiting for current trades to reach $0.50 profit`);
            }
            
            if (canStack) {
              const latestCandleTime = sortedChart[0]?.x || 0;
              
              // App Brain Level Calculation
              const h4Obs = sortedH4.length > 0 ? findOrderBlocks(sortedH4).filter(ob => !ob.mitigated) : [];
              const h4Levels = sortedH4.length > 0 ? findKeyLevels(sortedH4) : [];
              const h1Levels = sortedH1.length > 0 ? findKeyLevels(sortedH1) : [];
              const m15Levels = sortedM15.length > 0 ? findKeyLevels(sortedM15) : [];
              
              const allLevels = [...h4Levels, ...h1Levels, ...m15Levels];
              
              if (allLevels.length > 0 && Math.random() > 0.99) {
                addLog({ level: 'info', message: `🧠 App Brain: Calculated ${allLevels.length} key levels from HTF data`, timestamp: new Date().toISOString() });
              }

              const m15Obs = sortedM15.length > 0 ? findOrderBlocks(sortedM15).filter(ob => !ob.mitigated) : [];
              const m5Fvgs = sortedChart.length > 0 ? findFVGs(sortedChart).filter(fvg => !fvg.mitigated) : [];

              const levelDistanceBuffer = Math.max(atr * 0.35, price * 0.00025);
              const inOb = (p: number, obs: OrderBlock[]) => obs.some((ob) => p >= (ob.bottom - levelDistanceBuffer) && p <= (ob.top + levelDistanceBuffer));
              const inFvg = (p: number, fvgs: FVG[]) => fvgs.some((fvg) => p >= (fvg.bottom - levelDistanceBuffer) && p <= (fvg.top + levelDistanceBuffer));
              
              const isNearSupport = (p: number) => {
                const htfSupp = [...h4Levels, ...h1Levels].filter(l => l.type === 'SUPPORT');
                const obs = [...h4Obs].filter(o => o.type === 'BULLISH');
                // Only consider M15/M5 if they are very fresh or align with HTF
                const ltfSupp = [...m15Levels].filter(l => l.type === 'SUPPORT');
                
                return htfSupp.some(l => Math.abs(p - l.price) <= levelDistanceBuffer) || 
                       obs.some(o => p >= o.bottom && p <= o.top) ||
                       (ltfSupp.some(l => Math.abs(p - l.price) <= levelDistanceBuffer * 0.5)); // LTF must be much closer
              };

              const isNearResistance = (p: number) => {
                const htfRes = [...h4Levels, ...h1Levels].filter(l => l.type === 'RESISTANCE');
                const obs = [...h4Obs].filter(o => o.type === 'BEARISH');
                const ltfRes = [...m15Levels].filter(l => l.type === 'RESISTANCE');
                
                return htfRes.some(l => Math.abs(p - l.price) <= levelDistanceBuffer) || 
                       obs.some(o => p >= o.bottom && p <= o.top) ||
                       (ltfRes.some(l => Math.abs(p - l.price) <= levelDistanceBuffer * 0.5));
              };
              
              // --- RANGE & MOMENTUM FILTERS ---
              const rsi = accountData.rsi || 50;
              const isOverbought = rsi > 70;
              const isOversold = rsi < 30;
              const inMiddleRange = rsi > 40 && rsi < 60; // Stop trading in no-man's land

              const supportNearbyNow = isNearSupport(price);
              const resistanceNearbyNow = isNearResistance(price);
              const supportRejectedRecently = sortedChart.slice(0, 3).some(c => isNearSupport(c.low));
              const resistanceRejectedRecently = sortedChart.slice(0, 3).some(c => isNearResistance(c.high));
              const atSupport = supportNearbyNow || supportRejectedRecently;
              const atResistance = resistanceNearbyNow || resistanceRejectedRecently;
              const levelConflict = atSupport && atResistance;
              
              const priceSlowing = detectPriceSlowing(sortedChart, 3);
              const rejection = detectRecentRejection(sortedChart);
              const sweep = detectSweep(sortedChart, 10);
              const volumeExpansion = detectVolumeExpansion(sortedChart);
              
              const allLevels = [...h4Levels, ...h1Levels, ...m15Levels];
              const supportLevels = allLevels.filter(l => l.type === 'SUPPORT');
              const resistanceLevels = allLevels.filter(l => l.type === 'RESISTANCE');
              const nearestSupportDistance = supportLevels.length > 0
                ? Math.min(...supportLevels.map(l => Math.abs(price - l.price)))
                : Number.POSITIVE_INFINITY;
              const nearestResistanceDistance = resistanceLevels.length > 0
                ? Math.min(...resistanceLevels.map(l => Math.abs(price - l.price)))
                : Number.POSITIVE_INFINITY;
              const directionalBuffer = atr * 0.45;
              
              // --- MICRO-REVERSAL DETECTION (M1 Confirmation with BOS) ---
              const m1Latest = sortedM1[0];
              const m1Prev = sortedM1[1];
              const m1Third = sortedM1[2];
              
              // M1 Break of Structure (BOS) requirement for micro-entries
              const m1BosBuy = m1Latest && m1Prev && m1Latest.close > m1Prev.high;
              const m1BosSell = m1Latest && m1Prev && m1Latest.close < m1Prev.low;
              
              const m1ReversalBuy = m1BosBuy && isBullish(m1Latest) && isBearish(m1Prev);
              const m1ReversalSell = m1BosSell && isBearish(m1Latest) && isBullish(m1Prev);

              // --- REVERSAL PATTERN DETECTION (3rd Candle Confirmation) ---
              const thirdLast = sortedChart[2];
              const fourthLast = sortedChart[3];
              const isBullishFlip = thirdLast && fourthLast && isBullish(thirdLast) && isBearish(fourthLast);
              const isBearishFlip = thirdLast && fourthLast && isBearish(thirdLast) && isBullish(fourthLast);

              // --- ANTI-CHASE FILTER ---
              const nearestLevel = allLevels.length > 0 ? allLevels.reduce((prev, curr) => 
                Math.abs(curr.price - price) < Math.abs(prev.price - price) ? curr : prev
              ) : null;
              
              const nearestLevelPrice = nearestLevel ? nearestLevel.price : 0;
              const maxChaseDistance = atr * 0.65;
              const isChasing = nearestLevelPrice > 0 && Math.abs(price - nearestLevelPrice) > maxChaseDistance;
              
              // --- BREAK AND RETEST DETECTION ---
              const latestCandle = sortedChart[0];
              const prevCandle = sortedChart[1];
              const hasBrokenAbove = nearestLevel && nearestLevel.type === 'RESISTANCE' && prevCandle.close > nearestLevel.price && latestCandle.low <= nearestLevel.price + (atr * 0.1);
              const hasBrokenBelow = nearestLevel && nearestLevel.type === 'SUPPORT' && prevCandle.close < nearestLevel.price && latestCandle.high >= nearestLevel.price - (atr * 0.1);

              // --- CHOPPINESS FILTER ---
              const bodyAvg = sortedChart.slice(1, 11).reduce((acc, c) => acc + Math.abs(c.close - c.open), 0) / 10;
              const isChoppy = atr < bodyAvg * 0.8;

              const latest = sortedChart[0];
              const previous = sortedChart[1];
              const latestBody = Math.abs(latest.close - latest.open);
              const prevBodyAbs = Math.abs(previous.close - previous.open);
              const bullishEngulfing =
                isBullish(latest) &&
                isBearish(previous) &&
                latest.open <= previous.close &&
                latest.close >= previous.open &&
                latestBody >= prevBodyAbs * 0.9;
              const bearishEngulfing =
                isBearish(latest) &&
                isBullish(previous) &&
                latest.open >= previous.close &&
                latest.close <= previous.open &&
                latestBody >= prevBodyAbs * 0.9;
              const lookbackRecent = sortedChart.slice(1, 8);
              const recentSwingHigh = lookbackRecent.length > 0 ? Math.max(...lookbackRecent.map(c => c.high)) : previous.high;
              const recentSwingLow = lookbackRecent.length > 0 ? Math.min(...lookbackRecent.map(c => c.low)) : previous.low;
              const currentSweptHighAndRejected =
                latest.high > recentSwingHigh &&
                latest.close < recentSwingHigh &&
                isBearish(latest) &&
                (latest.high - Math.max(latest.open, latest.close)) > (latestBody * 1.0);
              const currentSweptLowAndRejected =
                latest.low < recentSwingLow &&
                latest.close > recentSwingLow &&
                isBullish(latest) &&
                (Math.min(latest.open, latest.close) - latest.low) > (latestBody * 1.0);
              const lookbackBeforePrev = sortedChart.slice(2, 8);
              const prevRangeHigh = lookbackBeforePrev.length > 0 ? Math.max(...lookbackBeforePrev.map(c => c.high)) : previous.high;
              const prevRangeLow = lookbackBeforePrev.length > 0 ? Math.min(...lookbackBeforePrev.map(c => c.low)) : previous.low;
              const prevSweptHighAndRejected =
                previous.high > prevRangeHigh &&
                previous.close < prevRangeHigh &&
                (previous.high - Math.max(previous.open, previous.close)) > (prevBodyAbs * 1.1);
              const prevSweptLowAndRejected =
                previous.low < prevRangeLow &&
                previous.close > prevRangeLow &&
                (Math.min(previous.open, previous.close) - previous.low) > (prevBodyAbs * 1.1);
              const bearishConfirmAfterPrevSweep = isBearish(latest) && latest.close < previous.close;
              const bullishConfirmAfterPrevSweep = isBullish(latest) && latest.close > previous.close;
              const bullishReclaim =
                Boolean(nearestLevel) &&
                previous.close < nearestLevelPrice &&
                latest.close > nearestLevelPrice;
              const bearishReclaim =
                Boolean(nearestLevel) &&
                previous.close > nearestLevelPrice &&
                latest.close < nearestLevelPrice;
              
              // Find nearest key level for debug panel
              if (nearestLevel) {
                const distance = Math.abs(nearestLevel.price - price);
                setKeyLevelInfo({ level: nearestLevel.price, distance, type: nearestLevel.type });
                setKeyLevelDistance(nearestLevel.price, distance, nearestLevel.type);
              }
              
              const prevBody = Math.abs(previous.close - previous.open);
              const prevLowerWick = Math.min(previous.open, previous.close) - previous.low;
              const prevUpperWick = previous.high - Math.max(previous.open, previous.close);
              
              const isStrongBullishRejection = prevLowerWick > prevBody * 1.2 && prevLowerWick > prevUpperWick;
              const isStrongBearishRejection = prevUpperWick > prevBody * 1.2 && prevUpperWick > prevLowerWick;

              const h4Trend: 'UP' | 'DOWN' | 'RANGE' = (() => {
                if (sortedH4.length < 6) return 'RANGE';
                const change = (sortedH4[0].close - sortedH4[5].close) / sortedH4[5].close;
                if (change > 0.0003) return 'UP';
                if (change < -0.0003) return 'DOWN';
                return 'RANGE';
              })();
              const trendUp = h4Trend === 'UP' && fastEMA > slowEMA;
              const trendDown = h4Trend === 'DOWN' && fastEMA < slowEMA;
              
              const spreadOk = spread <= 30;
              
              if (!spreadOk && Math.random() > 0.95) {
                addLog({ level: 'warning', message: `⚠️ Trade blocked: Spread too high (${spread.toFixed(2)})`, timestamp: new Date().toISOString() });
              }
              if (levelConflict && Math.random() > 0.95) {
                addLog({ level: 'warning', message: `⚠️ Trade blocked: S/R conflict nearby`, timestamp: new Date().toISOString() });
              }

              // --- SIGNAL LOGIC ---
              const baseReady = spreadOk && !levelConflict;
              const sniperReady = baseReady && !isChoppy && !inMiddleRange; // Strict mode for non-sweep setups

              const recentExit = lastExitEventRef.current &&
                !lastExitEventRef.current.consumed &&
                (Date.now() - lastExitEventRef.current.ts) <= 15 * 60 * 1000;

              // -2. INSTANT LIQUIDITY SWEEP ENTRY (same candle rejection).
              if (
                baseReady &&
                !isChasing &&
                (currentSweptHighAndRejected && (atResistance || sweep === 'HIGH_SWEEP'))
              ) {
                signal = 'SELL';
                slPrice = latest.high + (atr * 0.12);
                tpPrice = price - (atr * 2.4);
                signalReason = 'LIQ_SWEEP_INSTANT_SELL';
                console.log(`⚡ INSTANT LIQ SWEEP SELL`);
              }
              else if (
                baseReady &&
                !isChasing &&
                (currentSweptLowAndRejected && (atSupport || sweep === 'LOW_SWEEP'))
              ) {
                signal = 'BUY';
                slPrice = latest.low - (atr * 0.12);
                tpPrice = price + (atr * 2.4);
                signalReason = 'LIQ_SWEEP_INSTANT_BUY';
                console.log(`⚡ INSTANT LIQ SWEEP BUY`);
              }
              // -1. OPPOSITE RE-ENTRY after recent SL/TP if a liquidity sweep forms.
              else if (
                baseReady &&
                !isChasing &&
                recentExit &&
                lastExitEventRef.current
              ) {
                const exit = lastExitEventRef.current;
                const bearishSweepSetup = sweep === 'HIGH_SWEEP' || (prevSweptHighAndRejected && bearishConfirmAfterPrevSweep);
                const bullishSweepSetup = sweep === 'LOW_SWEEP' || (prevSweptLowAndRejected && bullishConfirmAfterPrevSweep);

                if (exit.side === 'BUY' && bearishSweepSetup) {
                  signal = 'SELL';
                  slPrice = Math.max(previous.high, latest.high) + (atr * 0.22);
                  tpPrice = price - (atr * 2.4);
                  signalReason = `REENTRY_OPPOSITE_AFTER_${exit.reason}_SELL`;
                  console.log(`♻️ Opposite re-entry SELL after ${exit.reason} + sweep`);
                } else if (exit.side === 'SELL' && bullishSweepSetup) {
                  signal = 'BUY';
                  slPrice = Math.min(previous.low, latest.low) - (atr * 0.22);
                  tpPrice = price + (atr * 2.4);
                  signalReason = `REENTRY_OPPOSITE_AFTER_${exit.reason}_BUY`;
                  console.log(`♻️ Opposite re-entry BUY after ${exit.reason} + sweep`);
                }
              }

              // 0. PREV-CANDLE LIQUIDITY SWEEP + REJECTION (sell/buy on confirmation candle)
              else if (
                baseReady &&
                !isChasing &&
                prevSweptHighAndRejected &&
                bearishConfirmAfterPrevSweep
              ) {
                signal = 'SELL';
                slPrice = previous.high + (atr * 0.20);
                tpPrice = price - (atr * 2.6);
                signalReason = 'LIQ_SWEEP_PREV_HIGH_SELL';
                console.log(`🔻 LIQ SWEEP PREV-HIGH SELL`);
              }
              else if (
                baseReady &&
                !isChasing &&
                prevSweptLowAndRejected &&
                bullishConfirmAfterPrevSweep
              ) {
                signal = 'BUY';
                slPrice = previous.low - (atr * 0.20);
                tpPrice = price + (atr * 2.6);
                signalReason = 'LIQ_SWEEP_PREV_LOW_BUY';
                console.log(`🔺 LIQ SWEEP PREV-LOW BUY`);
              }
              // 1. ENGULFING RECLAIM REVERSAL (high priority flip after exhaustion)
              else if (
                sniperReady &&
                !isChasing &&
                bullishEngulfing &&
                (bullishReclaim || sweep === 'LOW_SWEEP' || atSupport) &&
                (priceSlowing || detectStrengthDecrease(sortedChart, 3))
              ) {
                signal = 'BUY';
                slPrice = Math.min(latest.low, previous.low) - (atr * 0.35);
                tpPrice = price + (atr * 2.8);
                signalReason = 'ENGULF_RECLAIM_BUY';
                console.log(`✅ ENGULF RECLAIM BUY`);
              }
              else if (
                sniperReady &&
                !isChasing &&
                bearishEngulfing &&
                (bearishReclaim || sweep === 'HIGH_SWEEP' || atResistance) &&
                (priceSlowing || detectStrengthDecrease(sortedChart, 3))
              ) {
                signal = 'SELL';
                slPrice = Math.max(latest.high, previous.high) + (atr * 0.35);
                tpPrice = price - (atr * 2.8);
                signalReason = 'ENGULF_RECLAIM_SELL';
                console.log(`✅ ENGULF RECLAIM SELL`);
              }
              // 1. MICRO-REVERSAL FLIP (M1 Chart at structural levels)
              else if (sniperReady && atSupport && m1ReversalBuy && !isChasing && (isOversold || !trendDown)) {
                signal = 'BUY';
                slPrice = (m1Latest?.low || price) - (atr * 0.3);
                tpPrice = price + (atr * 2.5);
                signalReason = 'MICRO_BOS_BUY';
                console.log(`💎 MICRO-BUY: M1 BOS at Structure`);
              }
              else if (sniperReady && atResistance && m1ReversalSell && !isChasing && (isOverbought || !trendUp)) {
                signal = 'SELL';
                slPrice = (m1Latest?.high || price) + (atr * 0.3);
                tpPrice = price - (atr * 2.5);
                signalReason = 'MICRO_BOS_SELL';
                console.log(`💎 MICRO-SELL: M1 BOS at Structure`);
              }
              // 0.5 FAST REVERSAL FLIP (M5 pattern) - Only allow if deeply overbought/oversold
              else if (sniperReady && atSupport && isBullishFlip && !isChasing && isOversold) {
                signal = 'BUY';
                slPrice = thirdLast.low - (atr * 0.4);
                tpPrice = price + (atr * 2.5);
                signalReason = 'FAST_FLIP_BUY';
                console.log(`🚀 FAST BUY: Deep Oversold Flip`);
              }
              else if (sniperReady && atResistance && isBearishFlip && !isChasing && isOverbought) {
                signal = 'SELL';
                slPrice = thirdLast.high + (atr * 0.4);
                tpPrice = price - (atr * 2.5);
                signalReason = 'FAST_FLIP_SELL';
                console.log(`🚀 FAST SELL: Deep Overbought Flip`);
              }
              // 1. REJECTION AT SUPPORT (Coming down to level)
              else if (sniperReady && atSupport && !isChasing && (isStrongBullishRejection || rejection === 'BULLISH' || sweep === 'LOW_SWEEP')) {
                signal = 'BUY';
                const lowestRecent = Math.min(latest.low, previous.low);
                slPrice = lowestRecent - (atr * 0.35);
                tpPrice = price + (atr * 2.5);
                signalReason = 'SUPPORT_REJECTION_BUY';
                console.log(`🟢 SUPPORT REJECTION BUY`);
              }
              // 2. REJECTION AT RESISTANCE (Going up to level)
              else if (sniperReady && atResistance && !isChasing && (isStrongBearishRejection || rejection === 'BEARISH' || sweep === 'HIGH_SWEEP')) {
                signal = 'SELL';
                const highestRecent = Math.max(latest.high, previous.high);
                slPrice = highestRecent + (atr * 0.35);
                tpPrice = price - (atr * 2.5);
                signalReason = 'RESISTANCE_REJECTION_SELL';
                console.log(`🔴 RESISTANCE REJECTION SELL`);
              }
              // 3. BREAK AND RETEST (Continuation)
              else if (sniperReady && !isChasing) {
                if (hasBrokenAbove && isBullish(latest)) {
                  signal = 'BUY';
                  slPrice = latest.low - (atr * 0.3);
                  tpPrice = price + (atr * 2.2);
                  signalReason = 'BREAK_RETEST_BUY';
                  console.log(`🚀 BREAK & RETEST BUY`);
                } else if (hasBrokenBelow && isBearish(latest)) {
                  signal = 'SELL';
                  slPrice = latest.high + (atr * 0.3);
                  tpPrice = price - (atr * 2.2);
                  signalReason = 'BREAK_RETEST_SELL';
                  console.log(`🚀 BREAK & RETEST SELL`);
                }
              }

              // Fallback early trend entry (only if no level conflict)
              if (signal === 'NONE' && !isChasing && !isChoppy && !atResistance && !atSupport) {
                if (trendUp && isBullish(latest) && latest.close > previous.close) {
                  signal = 'BUY';
                  slPrice = previous.low - (atr * 0.3);
                  tpPrice = price + (atr * 2.0);
                  signalReason = 'TREND_FALLBACK_BUY';
                } else if (trendDown && isBearish(latest) && latest.close < previous.close) {
                  signal = 'SELL';
                  slPrice = previous.high + (atr * 0.3);
                  tpPrice = price - (atr * 2.0);
                  signalReason = 'TREND_FALLBACK_SELL';
                }
              }

              if (signal === 'NONE') {
                if (Math.random() > 0.98) {
                  const blockers: string[] = [];
                  if (!spreadOk) blockers.push("spread");
                  if (levelConflict) blockers.push("levelConflict");
                  if (isChoppy) blockers.push("choppy");
                  if (inMiddleRange) blockers.push("midRSI");
                  if (isChasing) blockers.push("chasing");
                  addLog({ level: 'info', message: `🔎 Scanning | Price: ${price.toFixed(2)} | RSI: ${rsi.toFixed(0)} ${blockers.length > 0 ? `| Blocked: ${blockers.join(",")}` : ""}`, timestamp: new Date().toISOString() });
                }
              }

              // Final directional sanity check: never sell into nearby support, never buy into nearby resistance.
              if (signal === 'SELL' && (atSupport || nearestSupportDistance <= directionalBuffer)) {
                addLog({ level: 'warning', message: `❌ SELL cancelled: Support too close`, timestamp: new Date().toISOString() });
                signal = 'NONE';
              } else if (signal === 'BUY' && (atResistance || nearestResistanceDistance <= directionalBuffer)) {
                addLog({ level: 'warning', message: `❌ BUY cancelled: Resistance too close`, timestamp: new Date().toISOString() });
                signal = 'NONE';
              }

              // Hard risk gate: do not enter if SL distance is wider than 3 points.
              const maxSlDistancePoints = 3.0;
              if ((signal === 'BUY' || signal === 'SELL') && slPrice > 0) {
                const slDistance = Math.abs(price - slPrice);
                if (slDistance > maxSlDistancePoints) {
                  addLog({ level: 'warning', message: `❌ ${signal} cancelled: SL too wide (${slDistance.toFixed(2)})`, timestamp: new Date().toISOString() });
                  signal = 'NONE';
                }
              }

              if (signal !== 'NONE' && signal !== 'CLOSE_ALL' && lastSignalRef.current === signal && lastSignalCandleRef.current === latestCandleTime) {
                signal = 'NONE';
              }
              
              // EXECUTE SIGNAL IMMEDIATELY
              if (signal !== 'NONE' && signal !== 'CLOSE_ALL' && (now - lastTradeTimeRef.current > 5000)) { 
                lastTradeTimeRef.current = now;
                lastSignalRef.current = signal;
                lastSignalCandleRef.current = sortedChart[0]?.x || 0;
                
                // --- ANTI-HEDGING LOGIC: Close opposite positions before opening new ones ---
                const oppositePositions = openOrders.filter(p => p.type !== signal);
                if (oppositePositions.length > 0) {
                  console.log(`🔄 Opposite positions detected. Closing ${oppositePositions.length} trades before opening ${signal}`);
                  placeOrder({ 
                    symbol: accountDataSafe.eaSymbol || 'BTCUSD', 
                    type: 'CLOSE_ALL', 
                    lots: 0, sl: 0, tp: 0 
                  }).catch(e => console.error("Auto-close opposite failed:", e));
                  
                  // Add a small delay for the close to process on MT5
                  setTimeout(() => {
                    if (signalReason.indexOf('REENTRY_OPPOSITE_AFTER_') === 0 && lastExitEventRef.current) {
                      lastExitEventRef.current.consumed = true;
                    }
                    addLog({ level: 'info', message: `🚀 Executing ${signal} signal: ${signalReason}`, timestamp: new Date().toISOString() });
                    setLastSignalReason(signalReason || 'OPPOSITE_CLOSE_THEN_ENTRY');
                    placeOrder({
                      symbol: accountDataSafe.eaSymbol || 'BTCUSD',
                      type: signal,
                      lots: botSettings.defaultLots || 0.01,
                      sl: slPrice, tp: tpPrice
                    }).then(() => {
                      addLog({ level: 'success', message: `✅ ${signal} trade placed successfully on MT5`, timestamp: new Date().toISOString() });
                    }).catch(e => {
                      addLog({ level: 'error', message: `❌ ${signal} trade failed: ${e.message}`, timestamp: new Date().toISOString() });
                      console.error("SMC execution failed:", e);
                    });
                  }, 500);
                  return; // Exit this polling cycle to wait for close
                }

                if (signalReason.indexOf('REENTRY_OPPOSITE_AFTER_') === 0 && lastExitEventRef.current) {
                  lastExitEventRef.current.consumed = true;
                }
                addLog({ level: 'info', message: `🚀 Executing ${signal} signal: ${signalReason}`, timestamp: new Date().toISOString() });
                setLastSignalReason(signalReason || 'DIRECT_ENTRY');
                placeOrder({
                  symbol: accountDataSafe.eaSymbol || 'BTCUSD',
                  type: signal as any,
                  lots: botSettings.defaultLots || 0.01,
                  sl: slPrice, tp: tpPrice
                }).then(() => {
                  addLog({ level: 'success', message: `✅ ${signal} trade placed successfully on MT5`, timestamp: new Date().toISOString() });
                }).catch(e => {
                  addLog({ level: 'error', message: `❌ ${signal} trade failed: ${e.message}`, timestamp: new Date().toISOString() });
                  console.error("SMC execution failed:", e);
                });
              } else if (signal === 'CLOSE_ALL' && (now - lastTradeTimeRef.current > 2000)) {
                lastTradeTimeRef.current = now;
                addLog({ level: 'info', message: `🚀 Executing CLOSE ALL command`, timestamp: new Date().toISOString() });
                setLastSignalReason('TIME_EXIT_CLOSE_ALL');
                placeOrder({ symbol: accountDataSafe.eaSymbol || 'BTCUSD', type: 'CLOSE_ALL', lots: 0, sl: 0, tp: 0 })
                  .then(() => addLog({ level: 'success', message: `✅ All trades closed successfully`, timestamp: new Date().toISOString() }))
                  .catch(e => addLog({ level: 'error', message: `❌ Close All failed: ${e.message}`, timestamp: new Date().toISOString() }));
              }
            }
          }
        }
      }

      prevOpenOrdersRef.current = (openOrders || []).map((p: any) => ({ ...p }));
    } catch (error) {
      console.error('Polling error:', error);
      setError('Connection lost. Retrying...');
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [setAccount, setOpenPositions, setStructures, setError, setLoading, setLastSignalReason, setKeyLevelInfo, setKeyLevelDistance, addLog, botSettings]);

  useEffect(() => {
    refresh(true);
    const interval = setInterval(() => {
      refresh(false);
    }, 3000); // 3 seconds polling
    return () => clearInterval(interval);
  }, [refresh]);

  return { refresh };
};

// --- HELPER FUNCTIONS ---
function findOrderBlocks(chart: Candle[]): OrderBlock[] {
  const result: OrderBlock[] = [];
  for (let i = 1; i < chart.length - 2; i++) {
    const c = chart[i];
    const p = chart[i+1];
    if (c.close > c.open && p.close < p.open && (c.close - c.open) > (c.high - c.low) * 0.6) {
      result.push({ top: p.high, bottom: p.low, type: 'BULLISH', index: i, mitigated: false });
    } else if (c.close < c.open && p.close > p.open && (c.open - c.close) > (c.high - c.low) * 0.6) {
      result.push({ top: p.high, bottom: p.low, type: 'BEARISH', index: i, mitigated: false });
    }
  }
  return result;
}

function findFVGs(chart: Candle[]): FVG[] {
  const result: FVG[] = [];
  for (let i = 1; i < chart.length - 1; i++) {
    if (chart[i-1].low > chart[i+1].high) {
      result.push({ top: chart[i-1].low, bottom: chart[i+1].high, type: 'BEARISH', index: i, mitigated: false });
    } else if (chart[i-1].high < chart[i+1].low) {
      result.push({ top: chart[i+1].low, bottom: chart[i-1].high, type: 'BULLISH', index: i, mitigated: false });
    }
  }
  return result;
}

function findKeyLevels(chart: Candle[]): KeyLevel[] {
  const levels: KeyLevel[] = [];
  for (let i = 2; i < chart.length - 2; i++) {
    if (chart[i].low < chart[i-1].low && chart[i].low < chart[i+1].low) levels.push({ price: chart[i].low, type: 'SUPPORT', strength: 1 });
    if (chart[i].high > chart[i-1].high && chart[i].high > chart[i+1].high) levels.push({ price: chart[i].high, type: 'RESISTANCE', strength: 1 });
  }
  return levels;
}

function detectPriceSlowing(chart: Candle[], period: number): boolean {
  if (chart.length < period + 1) return false;
  const currentMove = Math.abs(chart[0].close - chart[1].close);
  const prevMove = Math.abs(chart[1].close - chart[2].close);
  return currentMove < prevMove;
}

function detectVolumeExpansion(chart: Candle[]): boolean {
  if (chart.length < 6) return false;
  const latestVol = chart[0].tick_volume || 0;
  if (latestVol === 0) {
    // Proxy: candle body expansion
    const latestBody = Math.abs(chart[0].close - chart[0].open);
    const avgBody = chart.slice(1, 6).reduce((acc, c) => acc + Math.abs(c.close - c.open), 0) / 5;
    return latestBody > avgBody * 1.5;
  }
  const avgVol = chart.slice(1, 6).reduce((acc, c) => acc + (c.tick_volume || 0), 0) / 5;
  return latestVol > avgVol * 1.3;
}

function detectLevelCross(price: number, prevPrice: number, levels: KeyLevel[]): boolean {
  return levels.some(lvl => 
    (prevPrice < lvl.price && price > lvl.price) || // Crossed Up
    (prevPrice > lvl.price && price < lvl.price)    // Crossed Down
  );
}

function detectStrengthDecrease(chart: Candle[], period: number): boolean { 
  if (chart.length < period + 1) return false;
  // Body size is decreasing
  const currentBody = Math.abs(chart[0].close - chart[0].open);
  const prevBody = Math.abs(chart[1].close - chart[1].open);
  return currentBody < prevBody;
}

function detectRecentRejection(chart: Candle[]): 'BULLISH' | 'BEARISH' | 'NONE' { 
  if (chart.length < 2) return 'NONE';
  const prev = chart[1];
  const body = Math.abs(prev.close - prev.open);
  const lowerWick = Math.min(prev.open, prev.close) - prev.low;
  const upperWick = prev.high - Math.max(prev.open, prev.close);
  
  if (lowerWick > body * 1.5 && lowerWick > upperWick) return 'BULLISH';
  if (upperWick > body * 1.5 && upperWick > lowerWick) return 'BEARISH';
  return 'NONE';
}

function detectSweep(chart: Candle[], period: number): 'HIGH_SWEEP' | 'LOW_SWEEP' | 'NONE' { 
  if (chart.length < period) return 'NONE';
  const latest = chart[0];
  const lookback = chart.slice(1, period);
  const highestHigh = Math.max(...lookback.map(c => c.high));
  const lowestLow = Math.min(...lookback.map(c => c.low));
  
  // Sweep High: price went above highest high but closed below it
  if (latest.high > highestHigh && latest.close < highestHigh) return 'HIGH_SWEEP';
  // Sweep Low: price went below lowest low but closed above it
  if (latest.low < lowestLow && latest.close > lowestLow) return 'LOW_SWEEP';
  
  return 'NONE';
}
function isNearLevelPrice(p: number, target: number, pct: number): boolean { return Math.abs(p - target) / target < pct; }
function isBullish(c: Candle): boolean { return c.close > c.open; }
function isBearish(c: Candle): boolean { return c.close < c.open; }
function findSwingLows(chart: Candle[]): { val: number }[] { 
  if (chart.length < 5) return [];
  const results: { val: number }[] = [];
  // Look back 40 candles for pivots
  for (let i = 2; i < Math.min(chart.length - 2, 40); i++) {
    if (chart[i].low < chart[i-1].low && chart[i].low < chart[i-2].low && 
        chart[i].low < chart[i+1].low && chart[i].low < chart[i+2].low) {
      results.push({ val: chart[i].low });
    }
  }
  return results; 
}

function findSwingHighs(chart: Candle[]): { val: number }[] { 
  if (chart.length < 5) return [];
  const results: { val: number }[] = [];
  // Look back 40 candles for pivots
  for (let i = 2; i < Math.min(chart.length - 2, 40); i++) {
    if (chart[i].high > chart[i-1].high && chart[i].high > chart[i-2].high && 
        chart[i].high > chart[i+1].high && chart[i].high > chart[i+2].high) {
      results.push({ val: chart[i].high });
    }
  }
  return results; 
}
