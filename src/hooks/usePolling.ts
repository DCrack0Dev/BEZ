import React, { useEffect, useCallback, useRef } from 'react';
import { useTradeStore } from '../store/useTradeStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { getAccountData } from '../api/account';
import { getOpenOrders, placeOrder } from '../api/orders';

// --- PURE SMC TRADING HELPERS ---
interface Candle {
  x: number; open: number; high: number; low: number; close: number; tick_volume?: number;
}

interface KeyLevel {
  price: number;
  type: 'SUPPORT' | 'RESISTANCE';
  strength: number;
  touches: number;
}

interface POI {
  price: number;
  type: 'BOS' | 'CHOCH' | 'LIQUIDITY';
  timeframe: string;
}

// Check if a candle is an up-close (bullish) or down-close (bearish)
const isBullish = (c: Candle) => c.close > c.open;
const isBearish = (c: Candle) => c.close < c.open;

// Find swing highs and lows
const findSwingHighs = (chart: Candle[], window: number = 2): {index: number, val: number}[] => {
  const swings = [];
  for (let i = window; i < chart.length - window; i++) {
    let isHigh = true;
    for (let j = 1; j <= window; j++) {
      if (chart[i].high <= chart[i - j].high || chart[i].high <= chart[i + j].high) {
        isHigh = false; break;
      }
    }
    if (isHigh) swings.push({index: i, val: chart[i].high});
  }
  return swings;
};

const findSwingLows = (chart: Candle[], window: number = 2): {index: number, val: number}[] => {
  const swings = [];
  for (let i = window; i < chart.length - window; i++) {
    let isLow = true;
    for (let j = 1; j <= window; j++) {
      if (chart[i].low >= chart[i - j].low || chart[i].low >= chart[i + j].low) {
        isLow = false; break;
      }
    }
    if (isLow) swings.push({index: i, val: chart[i].low});
  }
  return swings;
};

// Identify Fair Value Gaps (FVG)
export interface FVG { index: number; type: 'BULLISH'|'BEARISH'; top: number; bottom: number; mitigated: boolean; }
export const findFVGs = (chart: Candle[]): FVG[] => {
  const fvgs: FVG[] = [];
  for (let i = 2; i < chart.length; i++) {
    const c1 = chart[i];     // oldest
    const c2 = chart[i-1];   // middle (the gap candle)
    const c3 = chart[i-2];   // newest
    
    // Bullish FVG: c1 high < c3 low
    if (c1.high < c3.low && isBullish(c2)) {
      fvgs.push({ index: i-1, type: 'BULLISH', top: c3.low, bottom: c1.high, mitigated: false });
    }
    // Bearish FVG: c1 low > c3 high
    else if (c1.low > c3.high && isBearish(c2)) {
      fvgs.push({ index: i-1, type: 'BEARISH', top: c1.low, bottom: c3.high, mitigated: false });
    }
  }
  
  // Mark mitigated FVGs
  for (let fvg of fvgs) {
    for (let j = fvg.index - 1; j >= 0; j--) {
      const c = chart[j];
      if (fvg.type === 'BULLISH' && c.low <= fvg.top) fvg.mitigated = true;
      if (fvg.type === 'BEARISH' && c.high >= fvg.bottom) fvg.mitigated = true;
      if (fvg.mitigated) break;
    }
  }
  return fvgs;
};

// Find Order Blocks (OB)
export interface OrderBlock { index: number; type: 'BULLISH'|'BEARISH'; top: number; bottom: number; mitigated: boolean; }
export const findOrderBlocks = (chart: Candle[]): OrderBlock[] => {
  const obs: OrderBlock[] = [];
  const swingHighs = findSwingHighs(chart);
  const swingLows = findSwingLows(chart);
  
  for (let i = 1; i < chart.length - 3; i++) {
    const c = chart[i];
    const prevC = chart[i+1];
    const prevPrevC = chart[i+2];
    
    const bodySize = Math.abs(c.open - c.close);
    const isDisplacement = bodySize > (c.high - c.low) * 0.7; // Strong body
    
    if (isDisplacement) {
      if (isBullish(c)) {
        if (isBearish(prevC)) {
           obs.push({ index: i+1, type: 'BULLISH', top: prevC.high, bottom: prevC.low, mitigated: false });
        } else if (isBearish(prevPrevC)) {
           obs.push({ index: i+2, type: 'BULLISH', top: prevPrevC.high, bottom: prevPrevC.low, mitigated: false });
        }
      } else if (isBearish(c)) {
        if (isBullish(prevC)) {
           obs.push({ index: i+1, type: 'BEARISH', top: prevC.high, bottom: prevC.low, mitigated: false });
        } else if (isBullish(prevPrevC)) {
           obs.push({ index: i+2, type: 'BEARISH', top: prevPrevC.high, bottom: prevPrevC.low, mitigated: false });
        }
      }
    }
  }
  
  // Mark mitigated OBs
  for (let ob of obs) {
    for (let j = ob.index - 1; j >= 0; j--) {
      const c = chart[j];
      if (ob.type === 'BULLISH' && c.low <= ob.top) ob.mitigated = true;
      if (ob.type === 'BEARISH' && c.high >= ob.bottom) ob.mitigated = true;
      if (ob.mitigated) break;
    }
  }
  return obs;
};

// --- PURE SMC DETECTION FUNCTIONS ---

// Detect price slowing down (consecutive smaller candles)
const detectPriceSlowing = (chart: Candle[], lookback: number = 3): boolean => {
  if (chart.length < lookback + 1) return false;
  
  const recent = chart.slice(0, lookback);
  let slowingCount = 0;
  
  for (let i = 1; i < recent.length; i++) {
    const currentRange = recent[i-1].high - recent[i-1].low;
    const previousRange = recent[i].high - recent[i].low;
    
    if (currentRange < previousRange * 0.7) { // 30% reduction in range
      slowingCount++;
    }
  }
  
  return slowingCount >= Math.floor(lookback * 0.6); // 60% of candles showing slowing
};

// Detect volume falling
const detectVolumeFalling = (chart: Candle[], lookback: number = 3): boolean => {
  if (chart.length < lookback + 1) return false;
  
  const recent = chart.slice(0, lookback);
  let fallingCount = 0;
  
  for (let i = 1; i < recent.length; i++) {
    const currentVolume = recent[i-1].tick_volume || 0;
    const previousVolume = recent[i].tick_volume || 0;
    
    if (currentVolume < previousVolume * 0.8) { // 20% reduction in volume
      fallingCount++;
    }
  }
  
  return fallingCount >= Math.floor(lookback * 0.6);
};

// Detect strength decrease (weaker candle bodies)
const detectStrengthDecrease = (chart: Candle[], lookback: number = 3): boolean => {
  if (chart.length < lookback + 1) return false;
  
  const recent = chart.slice(0, lookback);
  let weakeningCount = 0;
  
  for (let i = 1; i < recent.length; i++) {
    const currentBody = Math.abs(recent[i-1].close - recent[i-1].open);
    const previousBody = Math.abs(recent[i].close - recent[i].open);
    const currentRange = recent[i-1].high - recent[i-1].low;
    
    // Body to range ratio decreasing
    const currentBodyRatio = currentRange > 0 ? currentBody / currentRange : 0;
    const previousBodyRatio = currentRange > 0 ? previousBody / (recent[i].high - recent[i].low) : 0;
    
    if (currentBodyRatio < previousBodyRatio * 0.8) {
      weakeningCount++;
    }
  }
  
  return weakeningCount >= Math.floor(lookback * 0.6);
};

// Detect rejection patterns at levels
const detectRejection = (chart: Candle[]): 'BULLISH_REJECTION' | 'BEARISH_REJECTION' | 'NONE' => {
  if (chart.length < 2) return 'NONE';
  
  const latest = chart[0];
  const previous = chart[1];
  
  // Bullish rejection (long upper wick, close near low)
  if (latest.high > previous.high && latest.close < latest.open && 
      (latest.high - latest.close) > (latest.close - latest.low) * 2) {
    return 'BULLISH_REJECTION';
  }
  
  // Bearish rejection (long lower wick, close near high)
  if (latest.low < previous.low && latest.close > latest.open && 
      (latest.close - latest.low) > (latest.high - latest.close) * 2) {
    return 'BEARISH_REJECTION';
  }
  
  return 'NONE';
};

// Detect high/low sweeps
const detectSweep = (chart: Candle[], lookback: number = 10): 'HIGH_SWEEP' | 'LOW_SWEEP' | 'NONE' => {
  if (chart.length < lookback + 1) return 'NONE';
  
  const recent = chart.slice(0, lookback);
  const latest = chart[0];
  
  const highestHigh = Math.max(...recent.slice(1).map(c => c.high));
  const lowestLow = Math.min(...recent.slice(1).map(c => c.low));
  
  // High sweep: price goes above recent high then reverses
  if (latest.high > highestHigh && latest.close < latest.open) {
    return 'HIGH_SWEEP';
  }
  
  // Low sweep: price goes below recent low then reverses
  if (latest.low < lowestLow && latest.close > latest.open) {
    return 'LOW_SWEEP';
  }
  
  return 'NONE';
};

// Find key levels (swing highs/lows with multiple touches)
const findKeyLevels = (chart: Candle[], tolerance: number = 0.001): KeyLevel[] => {
  const levels: KeyLevel[] = [];
  const swingHighs = findSwingHighs(chart, 3);
  const swingLows = findSwingLows(chart, 3);
  
  // Process swing highs as resistance
  swingHighs.forEach(sh => {
    let touches = 0;
    chart.forEach(candle => {
      if (Math.abs(candle.high - sh.val) <= sh.val * tolerance) {
        touches++;
      }
    });
    
    if (touches >= 2) {
      levels.push({
        price: sh.val,
        type: 'RESISTANCE',
        strength: touches,
        touches
      });
    }
  });
  
  // Process swing lows as support
  swingLows.forEach(sl => {
    let touches = 0;
    chart.forEach(candle => {
      if (Math.abs(candle.low - sl.val) <= sl.val * tolerance) {
        touches++;
      }
    });
    
    if (touches >= 2) {
      levels.push({
        price: sl.val,
        type: 'SUPPORT',
        strength: touches,
        touches
      });
    }
  });
  
  return levels;
};

// Check if price is at any SMC level
const isAtSMCLevel = (price: number, chart: Candle[], tolerance: number = 0.002): boolean => {
  const keyLevels = findKeyLevels(chart, tolerance);
  const fvgs = findFVGs(chart).filter(fvg => !fvg.mitigated);
  const obs = findOrderBlocks(chart).filter(ob => !ob.mitigated);
  
  // Check key levels
  for (const level of keyLevels) {
    if (Math.abs(price - level.price) <= price * tolerance) {
      return true;
    }
  }
  
  // Check FVGs
  for (const fvg of fvgs) {
    if (price >= fvg.bottom && price <= fvg.top) {
      return true;
    }
  }
  
  // Check Order Blocks
  for (const ob of obs) {
    if (price >= ob.bottom && price <= ob.top) {
      return true;
    }
  }
  
  return false;
};

export const usePolling = () => {
  const { setAccount, setOpenPositions, setStructures, setLoading, setError, openPositions } = useTradeStore();
  const { botSettings } = useSettingsStore();
  const lastSignalRef = useRef<'BUY' | 'SELL' | 'NONE'>('NONE');
  const prevAutoTrading = useRef<boolean>(botSettings.autoTradingEnabled);
  const lastTradeTimeRef = useRef<number>(0);
  const lastDrawTimeRef = useRef<number>(0);

  const refresh = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const [accountData, openOrders] = await Promise.all([
        getAccountData(),
        getOpenOrders(),
      ]);
      
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
      
      const accountDataSafe = {
        balance: accountData.balance || 0,
        equity: accountData.equity || 0,
        pnlToday: accountData.pnl_today || accountData.pnlToday || 0,
        eaConnected: accountData.ea_connected || accountData.eaConnected || false,
        eaSymbol: accountData.eaSymbol || accountData.ea_symbol || 'BTCUSD',
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
        chart: safeChart,
      };
      
      setAccount(accountDataSafe);
      setOpenPositions(openOrders);
      setStructures(accountData.structures || {});
      setError(null);

      // Sync bot settings
      if (prevAutoTrading.current !== botSettings.autoTradingEnabled) {
        prevAutoTrading.current = botSettings.autoTradingEnabled;
        if (accountData.ea_connected) {
          console.log(`🤖 Auto-trading: ${botSettings.autoTradingEnabled ? 'RESUME' : 'PAUSE'}`);
          placeOrder({
            symbol: accountData.ea_symbol || accountData.eaSymbol || 'BTCUSD',
            type: botSettings.autoTradingEnabled ? 'RESUME' : 'PAUSE',
            lots: 0,
            sl: 0,
            tp: 0
          }).catch(e => console.error("Auto-trade sync failed:", e));
        }
      }

      // --- PURE SMC APP BRAIN ---
      if (botSettings.autoTradingEnabled && accountData.ea_connected) {
        let chart = [];
        let h1Chart = [];
        let m30Chart = [];
        let m15Chart = [];
        
        if (accountData.chart) {
          if (Array.isArray(accountData.chart)) {
            chart = accountData.chart;
          } else {
            chart = accountData.chart['M5'] || accountData.chart['M1'] || [];
            h1Chart = accountData.chart['H1'] || [];
            m30Chart = accountData.chart['M30'] || [];
            m15Chart = accountData.chart['M15'] || [];
          }
        }
        
        const price = accountData.price || 0;
        const atr = accountData.atr || 0;
        const spread = accountData.spread || 0;
        const equity = accountData.equity || 1000;
        
        // Basic filters
        if (spread > 35 || atr > 6.0) {
          return; // Skip if spread too wide or volatility too high
        }
        
        // Session filter (London/NY overlap)
        const now = new Date();
        const hourGMT = now.getUTCHours();
        if (hourGMT < 8 || hourGMT >= 17) {
          return; // Trade only during active sessions
        }
        
        // Daily loss limit
        const dailyLossLimit = accountData.balance * 0.03;
        if (accountData.pnl_today <= -dailyLossLimit) {
          console.log('🛑 Daily drawdown limit reached');
          return;
        }
        
        // Ensure we have enough data
        if (atr > 0 && chart.length >= 10) {
          const sortedChart = [...chart].sort((a, b) => b.x - a.x);
          const sortedH1 = h1Chart.length > 0 ? [...h1Chart].sort((a, b) => b.x - a.x) : [];
          
          let signal: 'BUY' | 'SELL' | 'NONE' | 'CLOSE_ALL' = 'NONE';
          let slPrice = 0;
          let tpPrice = 0;
          
          const totalOpen = openOrders.length;
          
          // Exit logic - time based
          if (totalOpen > 0) {
            const oldestTrade = openOrders.reduce((oldest, current) => {
              return (current.time || 0) < (oldest.time || 0) ? current : oldest;
            }, openOrders[0]);
            
            if (oldestTrade && oldestTrade.time) {
              const tradeAgeSeconds = Math.floor(Date.now() / 1000) - oldestTrade.time;
              if (tradeAgeSeconds > 600) { // 10 minutes max
                signal = 'CLOSE_ALL';
                console.log(`⏱️ Time exit: ${tradeAgeSeconds}s`);
              }
            }
          }
          
          // PURE SMC ENTRY LOGIC
          if (signal === 'NONE' && totalOpen === 0) {
            // Check if price is at SMC level
            const isAtLevel = isAtSMCLevel(price, sortedChart);
            
            if (isAtLevel) {
              console.log(`📍 Price at SMC level: ${price}`);
              
              // Detect SMC conditions
              const priceSlowing = detectPriceSlowing(sortedChart, 3);
              const volumeFalling = detectVolumeFalling(sortedChart, 3);
              const strengthDecreasing = detectStrengthDecrease(sortedChart, 3);
              const rejection = detectRejection(sortedChart);
              const sweep = detectSweep(sortedChart, 10);
              
              console.log(`🔍 SMC Analysis: Slowing=${priceSlowing}, Volume=${volumeFalling}, Strength=${strengthDecreasing}, Rejection=${rejection}, Sweep=${sweep}`);
              
              // BUY CONDITIONS
              if (rejection === 'BULLISH_REJECTION' || sweep === 'LOW_SWEEP') {
                if (priceSlowing && volumeFalling && strengthDecreasing) {
                  const swingLows = findSwingLows(sortedChart);
                  const potentialSL = swingLows.length > 0 ? swingLows[0].val : price - atr;
                  const potentialTP = price + (atr * 2);
                  
                  const risk = price - potentialSL;
                  const reward = potentialTP - price;
                  
                  if (risk > 0 && (reward / risk) >= 2.0) {
                    signal = 'BUY';
                    slPrice = potentialSL;
                    tpPrice = potentialTP;
                    console.log(`🟢 PURE SMC BUY - Rejection/Sweep confirmed at level`);
                  }
                }
              }
              
              // SELL CONDITIONS
              else if (rejection === 'BEARISH_REJECTION' || sweep === 'HIGH_SWEEP') {
                if (priceSlowing && volumeFalling && strengthDecreasing) {
                  const swingHighs = findSwingHighs(sortedChart);
                  const potentialSL = swingHighs.length > 0 ? swingHighs[0].val : price + atr;
                  const potentialTP = price - (atr * 2);
                  
                  const risk = potentialSL - price;
                  const reward = price - potentialTP;
                  
                  if (risk > 0 && (reward / risk) >= 2.0) {
                    signal = 'SELL';
                    slPrice = potentialSL;
                    tpPrice = potentialTP;
                    console.log(`🔴 PURE SMC SELL - Rejection/Sweep confirmed at level`);
                  }
                }
              }
            }
          }
          
          // Draw zones on chart
          const now = Date.now();
          if (now - lastDrawTimeRef.current > 5000) {
            lastDrawTimeRef.current = now;
            
            const activeOBs = sortedH1.length > 0 ? findOrderBlocks(sortedH1).filter(ob => !ob.mitigated) : [];
            const activeFVGs = sortedChart.length > 0 ? findFVGs(sortedChart).filter(fvg => !fvg.mitigated) : [];
            const keyLevels = findKeyLevels(sortedH1.length > 0 ? sortedH1 : sortedChart);
            
            // Draw Order Blocks
            activeOBs.forEach(ob => {
              const obTime = sortedH1[ob.index]?.x || sortedH1[0]?.x;
              placeOrder({
                symbol: accountData.ea_symbol || accountData.eaSymbol || 'BTCUSD',
                type: 'DRAW_OB',
                lots: 0, sl: 0, tp: 0,
                top: ob.top,
                bottom: ob.bottom,
                zoneType: ob.type,
                time: obTime
              }).catch(e => console.error("Draw OB failed:", e));
            });
            
            // Draw FVGs
            activeFVGs.forEach(fvg => {
              const fvgTime = sortedChart[fvg.index]?.x || sortedChart[0]?.x;
              placeOrder({
                symbol: accountData.ea_symbol || accountData.eaSymbol || 'BTCUSD',
                type: 'DRAW_FVG',
                lots: 0, sl: 0, tp: 0,
                top: fvg.top,
                bottom: fvg.bottom,
                zoneType: fvg.type,
                time: fvgTime
              }).catch(e => console.error("Draw FVG failed:", e));
            });
            
            // Draw Key Levels
            keyLevels.forEach(level => {
              placeOrder({
                symbol: accountData.ea_symbol || accountData.eaSymbol || 'BTCUSD',
                type: 'DRAW_KEY_LEVEL',
                lots: 0, sl: 0, tp: 0,
                price: level.price,
                levelType: level.type.toLowerCase()
              }).catch(e => console.error("Draw Key Level failed:", e));
            });
          }
          
          // Execute signals
          if (signal !== 'NONE' && signal !== 'CLOSE_ALL' && (now - lastTradeTimeRef.current > 2000)) {
            lastTradeTimeRef.current = now;
            console.log(`🚀 PURE SMC SIGNAL: ${signal} | Price: ${price} | SL: ${slPrice} | TP: ${tpPrice}`);
            
            placeOrder({
              symbol: accountData.ea_symbol || accountData.eaSymbol || 'BTCUSD',
              type: signal,
              lots: 0,
              sl: slPrice,
              tp: tpPrice
            }).catch(e => console.error("SMC execution failed:", e));
            
          } else if (signal === 'CLOSE_ALL' && (now - lastTradeTimeRef.current > 2000)) {
            lastTradeTimeRef.current = now;
            console.log(`🚀 PURE SMC CLOSE ALL`);
            placeOrder({
              symbol: accountData.ea_symbol || accountData.eaSymbol || 'BTCUSD',
              type: 'CLOSE_ALL',
              lots: 0,
              sl: 0,
              tp: 0
            }).catch(e => console.error("SMC close failed:", e));
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
