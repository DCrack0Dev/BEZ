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
        rsi: accountData.rsi || 0,
        atr: accountData.atr || 0,
        vwap: accountData.vwap || 0,
        spread: accountData.spread || 0,
        tickVolume: accountData.tickVolume || 0,
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
        // Use M5 chart for the trading brain logic if available, else M1 or empty
        let chart = [];
        let h1Chart = [];
        if (accountData.chart) {
          if (Array.isArray(accountData.chart)) {
            chart = accountData.chart;
          } else {
            chart = accountData.chart['M5'] || accountData.chart['M1'] || [];
            h1Chart = accountData.chart['H1'] || [];
          }
        }
        
        const price = accountData.price || 0;
        const fastEMA = accountData.fastEMA || 0;
        const slowEMA = accountData.slowEMA || 0;
        const bbUpper = accountData.bbUpper || 0;
        const bbLower = accountData.bbLower || 0;
        const rsi = accountData.rsi || 0;
        const atr = accountData.atr || 0;
        const vwap = accountData.vwap || 0;
        const spread = accountData.spread || 0;
        const tickVolume = accountData.tickVolume || 0;
        const equity = accountData.equity || 1000;
        
        // --- VWAP REVERSION STRATEGY (GOLD) ---
        // Filters
        const USE_SPREAD_FILTER = true;
        const USE_VOLATILITY_FILTER = true;
        const USE_SESSION_FILTER = true;
        const USE_KILL_SWITCH = true;

        if (USE_KILL_SWITCH) {
          const dailyLossLimit = accountData.balance * 0.03; // 3% daily drawdown kill switch
          if (accountData.pnl_today <= -dailyLossLimit) {
            console.log('🛑 Daily drawdown kill switch activated. Trading halted.');
            return; 
          }
        }

        if (USE_SPREAD_FILTER) {
          if (spread > 35) { // Spread under 35 points
            return;
          }
        }

        if (USE_VOLATILITY_FILTER) {
          // Skip if ATR is extremely high (news frenzy)
          // XAUUSD normal M5 ATR is around 1-3. We'll set a reasonable cap.
          if (atr > 6.0) {
            return;
          }
        }

        if (USE_SESSION_FILTER) {
          const now = new Date();
          const hourGMT = now.getUTCHours();
          const minute = now.getUTCMinutes();
          
          // Avoid first 15 mins of London open (08:00 - 08:15)
          if (hourGMT === 8 && minute < 15) {
             return;
          }
          
          // Trade only 08:00 to 17:00
          if (hourGMT < 8 || hourGMT >= 17) {
             return;
          }
        }
        
        // Ensure we have enough data
        if (vwap > 0 && atr > 0 && chart.length >= 2) {
          // Sort chart descending so x is highest (newest candle) first
          const sortedChart = [...chart].sort((a, b) => b.x - a.x);
          const c1 = sortedChart[1]; // Latest closed candle
          
          const isBullish = c1.close > c1.open;
          const isBearish = c1.close < c1.open;
          
          const bodySize = Math.abs(c1.close - c1.open);
          const isStrongBody = bodySize > (price * 0.0001); // Avoid dojis
          
          let signal: 'BUY' | 'SELL' | 'NONE' | 'CLOSE_ALL' = 'NONE';
          let slPrice = 0;
          let tpPrice = vwap; // TP is always VWAP

          const totalOpen = openOrders.length;

          // Exit Logic
          if (totalOpen > 0) {
            // Time-based exit: 10 mins max hold
            const oldestTrade = openOrders.reduce((oldest, current) => {
              return (current.time || 0) < (oldest.time || 0) ? current : oldest;
            }, openOrders[0]);
            
            if (oldestTrade && oldestTrade.time) {
              const tradeAgeSeconds = Math.floor(Date.now() / 1000) - oldestTrade.time;
              if (tradeAgeSeconds > 600) { // 10 minutes
                 signal = 'CLOSE_ALL';
                 console.log(`⏱️ Time decay exit triggered. Age: ${tradeAgeSeconds}s`);
              }
            }
            
            // Breakeven logic could be implemented here or via EA's trailing stop
            // We'll rely on EA's trailing stop or implement a basic breakeven if needed
            // The strategy asks to move SL to entry once 80 points in profit.
            // Since EA handles SL modification, we can let the EA's Trailing Stop handle it 
            // if configured to 80 points.
          }

          // Entry Logic (Only 1 concurrent trade for this strategy usually, or max 1)
          if (signal === 'NONE' && totalOpen === 0) {
             
             // --- STRATEGY 1: VWAP REVERSION ---
             // BUY SETUP
             // 1. Price visibly below VWAP
             // 2. Distance >= 1x ATR(14)
             // 3. RSI(7) < 30
             // 4. Last closed candle bullish with strong body
             if (price < vwap) {
                const distance = vwap - price;
                if (distance >= atr && rsi < 30 && isBullish && isStrongBody) {
                   // Avoid if price is within 50 points of VWAP
                   if (distance > 0.50) { // 50 points = 0.50 for Gold
                      signal = 'BUY';
                      slPrice = price - 2.00; // 200 points below entry
                      tpPrice = vwap;
                   }
                }
             }
             
             // SELL SETUP
             // 1. Price visibly above VWAP
             // 2. Distance >= 1x ATR(14)
             // 3. RSI(7) > 70
             // 4. Last closed candle bearish with strong body
             if (price > vwap && signal === 'NONE') {
                const distance = price - vwap;
                if (distance >= atr && rsi > 70 && isBearish && isStrongBody) {
                   if (distance > 0.50) { // 50 points = 0.50 for Gold
                      signal = 'SELL';
                      slPrice = price + 2.00; // 200 points above entry
                      tpPrice = vwap;
                   }
                }
             }

             // --- STRATEGY 2: KEY LEVELS (Asian Range / H1 Support & Resistance) ---
             // Fallback if VWAP is not met
             if (signal === 'NONE' && h1Chart.length > 5) {
                // Extract Resistance (High) and Support (Low) from recent H1 candles (approx 20 hours)
                // Exclude the current forming candle (x=1) to ensure the level is established
                const closedH1 = h1Chart.filter((c: any) => c.x > 1);
                const resistance = Math.max(...closedH1.map((c: any) => c.high));
                const support = Math.min(...closedH1.map((c: any) => c.low));

                const distanceToRes = Math.abs(resistance - price);
                const distanceToSup = Math.abs(price - support);
                
                // Define "near" a key level (e.g., within 1x ATR)
                const nearThreshold = atr; 

                // 1. Resistance Rejection (SELL)
                if (distanceToRes <= nearThreshold && isBearish && isStrongBody && rsi > 60) {
                   signal = 'SELL';
                   slPrice = resistance + atr; // SL just above resistance
                   tpPrice = price - (atr * 3); // 1:3 RR approx
                   console.log(`🔑 Key Level Rejection: Resistance at ${resistance}`);
                }
                
                // 2. Support Rejection (BUY)
                else if (distanceToSup <= nearThreshold && isBullish && isStrongBody && rsi < 40) {
                   signal = 'BUY';
                   slPrice = support - atr; // SL just below support
                   tpPrice = price + (atr * 3);
                   console.log(`🔑 Key Level Rejection: Support at ${support}`);
                }
                
                // 3. Resistance Breakout (BUY)
                // If previous M5 candle closed strongly ABOVE H1 resistance
                else if (c1.close > resistance && c1.open < resistance && isBullish && isStrongBody) {
                   signal = 'BUY';
                   slPrice = resistance - atr; // SL below broken resistance
                   tpPrice = price + (atr * 4);
                   console.log(`🔑 Key Level Breakout: Broke Resistance at ${resistance}`);
                }
                
                // 4. Support Breakout (SELL)
                // If previous M5 candle closed strongly BELOW H1 support
                else if (c1.close < support && c1.open > support && isBearish && isStrongBody) {
                   signal = 'SELL';
                   slPrice = support + atr; // SL above broken support
                   tpPrice = price - (atr * 4);
                   console.log(`🔑 Key Level Breakout: Broke Support at ${support}`);
                }
             }
             // --- STRATEGY 3: REJECTION + ENGULFING CANDLE ---
             // Fallback if neither VWAP nor Key Levels hit
             if (signal === 'NONE' && chart.length >= 3) {
                const c2 = sortedChart[2]; // The candle before the last closed candle (the rejection candle)

                const c1Body = Math.abs(c1.close - c1.open);
                const c2Body = Math.abs(c2.close - c2.open);
                const c2UpperWick = c2.high - Math.max(c2.open, c2.close);
                const c2LowerWick = Math.min(c2.open, c2.close) - c2.low;
                
                const c1IsBullish = c1.close > c1.open;
                const c1IsBearish = c1.close < c1.open;

                // Define rejection: Wick is at least 2x the size of the body
                // Added a safeguard to ensure the body isn't practically zero (division by zero risk)
                const c2BodySafe = c2Body > 0.0001 ? c2Body : 0.0001; 
                const isBullishRejection = c2LowerWick > (c2BodySafe * 2);
                const isBearishRejection = c2UpperWick > (c2BodySafe * 2);

                // 1. BUY SETUP (Bullish Rejection followed by Bullish Engulfing)
                // c2 rejected lower prices (long bottom wick)
                // c1 completely engulfed c2's body and closed bullish
                if (isBullishRejection && c1IsBullish) {
                   const isEngulfing = c1.close > c2.high && c1.open <= Math.min(c2.open, c2.close);
                   if (isEngulfing && rsi < 50) { // Prefer buying from lower RSI
                      signal = 'BUY';
                      slPrice = c2.low - (atr * 0.5); // SL just below the rejection wick
                      tpPrice = price + (atr * 2); // 1:2 RR approx
                      console.log(`🕯️ Strategy 3: Bullish Rejection + Engulfing`);
                   }
                }

                // 2. SELL SETUP (Bearish Rejection followed by Bearish Engulfing)
                // c2 rejected higher prices (long top wick)
                // c1 completely engulfed c2's body and closed bearish
                if (isBearishRejection && c1IsBearish && signal === 'NONE') {
                   const isEngulfing = c1.close < c2.low && c1.open >= Math.max(c2.open, c2.close);
                   if (isEngulfing && rsi > 50) { // Prefer selling from higher RSI
                      signal = 'SELL';
                      slPrice = c2.high + (atr * 0.5); // SL just above the rejection wick
                      tpPrice = price - (atr * 2); // 1:2 RR approx
                      console.log(`🕯️ Strategy 3: Bearish Rejection + Engulfing`);
                   }
                }
             }
          }

          // Throttle trades to max 1 every 2 seconds
          const now = Date.now();
          if (signal !== 'NONE' && (now - lastTradeTimeRef.current > 2000)) {
            lastTradeTimeRef.current = now;
            console.log(`🚀 APP BRAIN SIGNAL: ${signal} | VWAP: ${vwap} | Price: ${price} | RSI: ${rsi}`);
            placeOrder({
              symbol: accountData.ea_symbol || 'XAUUSD',
              type: signal,
              lots: 0,
              sl: slPrice,
              tp: tpPrice
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
