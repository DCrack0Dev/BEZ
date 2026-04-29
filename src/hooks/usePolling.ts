import React, { useEffect, useCallback, useRef } from 'react';
import { useTradeStore } from '../store/useTradeStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { getAccountData } from '../api/account';
import { getOpenOrders, placeOrder } from '../api/orders';

// --- SMC / ICT STRATEGY HELPERS ---
interface Candle {
  x: number; open: number; high: number; low: number; close: number; tick_volume?: number;
}

type MarketStructure = 'UPTREND' | 'DOWNTREND' | 'RANGING' | 'CHOPPY';

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
// Returns array of FVGs. type: 'BULLISH' (demand) or 'BEARISH' (supply)
export interface FVG { index: number; type: 'BULLISH'|'BEARISH'; top: number; bottom: number; mitigated: boolean; }
export const findFVGs = (chart: Candle[]): FVG[] => {
  const fvgs: FVG[] = [];
  // Need at least 3 candles to form an FVG. chart[0] is newest.
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
  
  // Mark mitigated FVGs (A FVG is mitigated if price ever touched the gap zone AFTER it formed)
  // For index i, candles i-1, i-2, i-3 etc are NEWER.
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
  
  // Simplified logic: look for displacement (large candles) breaking recent swings
  for (let i = 1; i < chart.length - 3; i++) {
    const c = chart[i];
    const prevC = chart[i+1];
    const prevPrevC = chart[i+2];
    
    const bodySize = Math.abs(c.open - c.close);
    const isDisplacement = bodySize > (c.high - c.low) * 0.7; // Strong body
    
    if (isDisplacement) {
      if (isBullish(c)) {
        // Find the last down-close candle(s) before this up move
        if (isBearish(prevC)) {
           obs.push({ index: i+1, type: 'BULLISH', top: prevC.high, bottom: prevC.low, mitigated: false });
        } else if (isBearish(prevPrevC)) {
           obs.push({ index: i+2, type: 'BULLISH', top: prevPrevC.high, bottom: prevPrevC.low, mitigated: false });
        }
      } else if (isBearish(c)) {
        // Find the last up-close candle(s) before this down move
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

// Advanced Market Structure (ChoCh / BoS)
const identifyHTFStructure = (chart: Candle[]): { trend: MarketStructure, bosCount: number, choch: boolean } => {
  if (chart.length < 30) return { trend: 'CHOPPY', bosCount: 0, choch: false };
  const highs = findSwingHighs(chart, 3);
  const lows = findSwingLows(chart, 3);
  
  if (highs.length < 3 || lows.length < 3) return { trend: 'CHOPPY', bosCount: 0, choch: false };
  
  // Newest swings are at the start of the array
  const h1 = highs[0].val; const h2 = highs[1].val; const h3 = highs[2].val;
  const l1 = lows[0].val; const l2 = lows[1].val; const l3 = lows[2].val;
  
  let trend: MarketStructure = 'CHOPPY';
  let bosCount = 0;
  let choch = false;
  
  // Bullish Trend (Higher Highs, Higher Lows)
  if (h1 > h2 && h2 > h3 && l1 > l2 && l2 > l3) {
    trend = 'UPTREND';
    bosCount = 3;
    // Check for bearish ChoCh (price breaks below l1)
    if (chart[0].close < l1) choch = true;
  }
  // Bearish Trend (Lower Highs, Lower Lows)
  else if (h1 < h2 && h2 < h3 && l1 < l2 && l2 < l3) {
    trend = 'DOWNTREND';
    bosCount = 3;
    // Check for bullish ChoCh (price breaks above h1)
    if (chart[0].close > h1) choch = true;
  }
  
  return { trend, bosCount, choch };
};

const findNextKeyLevel = (chart: Candle[], currentPrice: number, direction: 'BUY' | 'SELL'): number => {
  const recent = chart.slice(1, 50); // Look back 50 candles for key levels
  if (direction === 'BUY') {
    // Find the next significant resistance above current price
    const levelsAbove = recent.map(c => c.high).filter(h => h > currentPrice);
    return levelsAbove.length > 0 ? Math.max(...levelsAbove) : currentPrice * 1.002; // Fallback
  } else {
    // Find the next significant support below current price
    const levelsBelow = recent.map(c => c.low).filter(l => l < currentPrice);
    return levelsBelow.length > 0 ? Math.min(...levelsBelow) : currentPrice * 0.998; // Fallback
  }
};

export const usePolling = () => {
  const { setAccount, setOpenPositions, setLoading, setError, openPositions } = useTradeStore();
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
        if (atr > 0 && chart.length >= 3) {
          // Sort chart descending so x is highest (newest candle) first
          const sortedChart = [...chart].sort((a, b) => b.x - a.x);
          const c1 = sortedChart[1]; // Latest closed candle
          
          let signal: 'BUY' | 'SELL' | 'NONE' | 'CLOSE_ALL' = 'NONE';
          let slPrice = 0;
          let tpPrice = 0;

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
          }

          // Entry Logic (Only 1 concurrent trade for this strategy usually, or max 1)
          if (signal === 'NONE' && totalOpen === 0) {
             
             // Sort HTF charts
             const sortedH1 = h1Chart.length > 0 ? [...h1Chart].sort((a: any, b: any) => b.x - a.x) : [];
             const sortedM30 = m30Chart.length > 0 ? [...m30Chart].sort((a: any, b: any) => b.x - a.x) : [];
             const sortedM15 = m15Chart.length > 0 ? [...m15Chart].sort((a: any, b: any) => b.x - a.x) : [];
             
             // Store these in refs or variables accessible outside the `if` block for drawing
             (window as any)._sortedH1 = sortedH1;
             (window as any)._sortedChart = sortedChart;
             
             // Get HTF Structure
             const h1Struct = identifyHTFStructure(sortedH1);
             
             // --- STRATEGY 1: LIQUIDITY SWEEP + ORDER BLOCK + IFVG ---
             // Timeframes: M15/M30 as HTF, M5/M1 as Entry
             const htfChart = sortedM30.length > 15 ? sortedM30 : sortedM15;
             if (htfChart.length > 15) {
               // Step 1 & 2: HTF Liquidity Sweep & Order Block
               // Since checking real-time OB formation on HTF is complex, we identify existing OBs on HTF
               const htfOBs = findOrderBlocks(htfChart);
               const unmitigatedHTFOBs = htfOBs.filter(ob => !ob.mitigated);
               
               // Step 3: Wait for price to return to HTF OB
               for (let ob of unmitigatedHTFOBs) {
                 const inZone = price <= ob.top && price >= ob.bottom;
                 
                 if (inZone) {
                   // Step 4 & 5: Zoom to LTF (M5) and look for IFVG + Market Structure Shift
                   const ltfFVGs = findFVGs(sortedChart);
                   const ltfStruct = identifyHTFStructure(sortedChart); // LTF choch/bos
                   
                   // Look for an IFVG (violated FVG)
                   // A bullish FVG that was broken below becomes a bearish IFVG
                   // A bearish FVG that was broken above becomes a bullish IFVG
                   
                   // Simplified: If we are in a HTF Bullish OB, we want to BUY
                   if (ob.type === 'BULLISH' && ltfStruct.choch && ltfStruct.trend === 'UPTREND') {
                      // We need a bullish FVG to form on LTF
                      const recentBullishFVGs = ltfFVGs.filter(f => f.type === 'BULLISH' && !f.mitigated);
                      if (recentBullishFVGs.length > 0) {
                         const entryFVG = recentBullishFVGs[0];
                         
                         // Step 6: Entry Option 1 (Enter immediately after formation)
                         const potentialEntry = price;
                         const potentialSL = findSwingLows(sortedChart)[0]?.val || (price - atr);
                         const potentialTP = findNextKeyLevel(htfChart, price, 'BUY');
                         
                         const risk = potentialEntry - potentialSL;
                         const reward = potentialTP - potentialEntry;
                         
                         if (risk > 0 && (reward / risk) >= 2.0) {
                            signal = 'BUY';
                            slPrice = potentialSL;
                            tpPrice = potentialTP;
                            console.log(`🟢 Strat 1 (Liq Sweep+OB+IFVG) BUY. Entry: ${potentialEntry}, SL: ${potentialSL}, TP: ${potentialTP}, RR: ${(reward/risk).toFixed(2)}`);
                            break; // Trade found
                         }
                      }
                   }
                   // If we are in a HTF Bearish OB, we want to SELL
                   else if (ob.type === 'BEARISH' && ltfStruct.choch && ltfStruct.trend === 'DOWNTREND') {
                      const recentBearishFVGs = ltfFVGs.filter(f => f.type === 'BEARISH' && !f.mitigated);
                      if (recentBearishFVGs.length > 0) {
                         const entryFVG = recentBearishFVGs[0];
                         
                         const potentialEntry = price;
                         const potentialSL = findSwingHighs(sortedChart)[0]?.val || (price + atr);
                         const potentialTP = findNextKeyLevel(htfChart, price, 'SELL');
                         
                         const risk = potentialSL - potentialEntry;
                         const reward = potentialEntry - potentialTP;
                         
                         if (risk > 0 && (reward / risk) >= 2.0) {
                            signal = 'SELL';
                            slPrice = potentialSL;
                            tpPrice = potentialTP;
                            console.log(`🔴 Strat 1 (Liq Sweep+OB+IFVG) SELL. Entry: ${potentialEntry}, SL: ${potentialSL}, TP: ${potentialTP}, RR: ${(reward/risk).toFixed(2)}`);
                            break;
                         }
                      }
                   }
                 }
               }
             }

             // --- STRATEGY 2: SUPPLY AND DEMAND ZONE + BREAKER BLOCK ---
             // Timeframes: H1 as HTF, M5 as Entry
             if (signal === 'NONE' && sortedH1.length > 15) {
               // Step 1: Confirm Trend on HTF (H1)
               if (h1Struct.trend === 'UPTREND' || h1Struct.trend === 'DOWNTREND') {
                 // Step 2: Mark Demand/Supply Zone (Using HTF Order Blocks as proxy for zones)
                 const h1OBs = findOrderBlocks(sortedH1);
                 const unmitigatedH1OBs = h1OBs.filter(ob => {
                   if (ob.mitigated) return false;
                   if (h1Struct.trend === 'UPTREND' && ob.type === 'BULLISH') return true;
                   if (h1Struct.trend === 'DOWNTREND' && ob.type === 'BEARISH') return true;
                   return false;
                 });
                 
                 // Step 3: Wait for price to return to zone
                 for (let zone of unmitigatedH1OBs) {
                   const inZone = price <= zone.top && price >= zone.bottom;
                   
                   if (inZone) {
                     // Step 4 & 5: Zoom to M5, look for ChoCh and Breaker Block
                     const ltfStruct = identifyHTFStructure(sortedChart);
                     
                     // Simplified Breaker Block detection: A ChoCh after tapping a HTF zone is a strong breaker signal
                     if (zone.type === 'BULLISH' && ltfStruct.choch && ltfStruct.trend === 'UPTREND') {
                        // Step 6: Entry
                        const potentialEntry = price;
                        const potentialSL = findSwingLows(sortedChart)[0]?.val || (price - atr);
                        const potentialTP = findNextKeyLevel(sortedH1, price, 'BUY');
                        
                        const risk = potentialEntry - potentialSL;
                        const reward = potentialTP - potentialEntry;
                        
                        if (risk > 0 && (reward / risk) >= 2.0) {
                           signal = 'BUY';
                           slPrice = potentialSL;
                           tpPrice = potentialTP;
                           console.log(`🟢 Strat 2 (S&D+Breaker) BUY. Entry: ${potentialEntry}, SL: ${potentialSL}, TP: ${potentialTP}, RR: ${(reward/risk).toFixed(2)}`);
                           break;
                        }
                     }
                     else if (zone.type === 'BEARISH' && ltfStruct.choch && ltfStruct.trend === 'DOWNTREND') {
                        const potentialEntry = price;
                        const potentialSL = findSwingHighs(sortedChart)[0]?.val || (price + atr);
                        const potentialTP = findNextKeyLevel(sortedH1, price, 'SELL');
                        
                        const risk = potentialSL - potentialEntry;
                        const reward = potentialEntry - potentialTP;
                        
                        if (risk > 0 && (reward / risk) >= 2.0) {
                           signal = 'SELL';
                           slPrice = potentialSL;
                           tpPrice = potentialTP;
                           console.log(`🔴 Strat 2 (S&D+Breaker) SELL. Entry: ${potentialEntry}, SL: ${potentialSL}, TP: ${potentialTP}, RR: ${(reward/risk).toFixed(2)}`);
                           break;
                        }
                     }
                   }
                 }
               }
             }

             // --- STRATEGY 3: HTF CHOCH + FVG + IFVG ---
             // Timeframes: H1 as HTF, M15/M5 as Entry
             if (signal === 'NONE' && sortedH1.length > 15) {
                // Step 1 & 2: Identify Strong Trend & ChoCh on HTF
                if (h1Struct.choch) {
                   // Step 3: Mark FVG within ChoCh leg on HTF
                   const h1FVGs = findFVGs(sortedH1);
                   const recentH1FVGs = h1FVGs.filter(f => !f.mitigated);
                   
                   for (let htfFvg of recentH1FVGs) {
                      const inHTFFVG = price <= htfFvg.top && price >= htfFvg.bottom;
                      
                      // Step 4: Wait for price to enter HTF FVG
                      if (inHTFFVG) {
                         // Step 5: Look for IFVG on LTF (M5)
                         // We simplify IFVG detection by looking for a fresh LTF FVG in the direction of the ChoCh
                         const ltfFVGs = findFVGs(sortedChart);
                         
                         // If HTF was a bullish ChoCh (downtrend -> uptrend), look for bullish LTF FVG
                         if (h1Struct.trend === 'UPTREND' && htfFvg.type === 'BULLISH') {
                            const recentLTFBullishFVGs = ltfFVGs.filter(f => f.type === 'BULLISH' && !f.mitigated);
                            if (recentLTFBullishFVGs.length > 0) {
                               const potentialEntry = price;
                               const potentialSL = findSwingLows(sortedChart)[0]?.val || (price - atr);
                               const potentialTP = findNextKeyLevel(sortedH1, price, 'BUY');
                               
                               const risk = potentialEntry - potentialSL;
                               const reward = potentialTP - potentialEntry;
                               
                               if (risk > 0 && (reward / risk) >= 2.0) {
                                  signal = 'BUY';
                                  slPrice = potentialSL;
                                  tpPrice = potentialTP;
                                  console.log(`🟢 Strat 3 (HTF ChoCh+FVG) BUY. Entry: ${potentialEntry}, SL: ${potentialSL}, TP: ${potentialTP}, RR: ${(reward/risk).toFixed(2)}`);
                                  break;
                               }
                            }
                         }
                         // Bearish ChoCh
                         else if (h1Struct.trend === 'DOWNTREND' && htfFvg.type === 'BEARISH') {
                            const recentLTFBearishFVGs = ltfFVGs.filter(f => f.type === 'BEARISH' && !f.mitigated);
                            if (recentLTFBearishFVGs.length > 0) {
                               const potentialEntry = price;
                               const potentialSL = findSwingHighs(sortedChart)[0]?.val || (price + atr);
                               const potentialTP = findNextKeyLevel(sortedH1, price, 'SELL');
                               
                               const risk = potentialSL - potentialEntry;
                               const reward = potentialEntry - potentialTP;
                               
                               if (risk > 0 && (reward / risk) >= 2.0) {
                                  signal = 'SELL';
                                  slPrice = potentialSL;
                                  tpPrice = potentialTP;
                                  console.log(`🔴 Strat 3 (HTF ChoCh+FVG) SELL. Entry: ${potentialEntry}, SL: ${potentialSL}, TP: ${potentialTP}, RR: ${(reward/risk).toFixed(2)}`);
                                  break;
                               }
                            }
                         }
                      }
                   }
                }
             }
          }

          // Throttle trades to max 1 every 2 seconds
          const now = Date.now();

          // We want to ALWAYS draw the zones, even if we aren't trading right now.
          // Throttling zone drawing to every 5 seconds so we don't spam MT5
          if (now - lastDrawTimeRef.current > 5000) {
            lastDrawTimeRef.current = now;
            
            // Draw the zones on the chart via the backend
            // Let's get the active unmitigated zones from HTF (M30/M15 or H1)
            const _h1 = (window as any)._sortedH1 || [];
            const _chart = (window as any)._sortedChart || [];
            
            const activeOBs = _h1.length > 0 ? findOrderBlocks(_h1).filter(ob => !ob.mitigated) : [];
            const activeFVGs = _chart.length > 0 ? findFVGs(_chart).filter(fvg => !fvg.mitigated) : [];
            
            if (activeOBs.length > 0 || activeFVGs.length > 0) {
              console.log(`Sending ${activeOBs.length} OBs and ${activeFVGs.length} FVGs to MT5`);
            }
            
            // Send OB commands
            activeOBs.forEach(ob => {
              const obTime = _h1[ob.index]?.x || _h1[0]?.x;
              placeOrder({
                symbol: accountData.ea_symbol || 'XAUUSD',
                type: 'DRAW_OB',
                lots: 0, sl: 0, tp: 0,
                top: ob.top,
                bottom: ob.bottom,
                zoneType: ob.type,
                time: obTime // use candle index timestamp
              }).catch(e => console.error("Draw OB failed:", e));
            });
            
            // Send FVG commands
            activeFVGs.forEach(fvg => {
              const fvgTime = _chart[fvg.index]?.x || _chart[0]?.x;
              placeOrder({
                symbol: accountData.ea_symbol || 'XAUUSD',
                type: 'DRAW_FVG',
                lots: 0, sl: 0, tp: 0,
                top: fvg.top,
                bottom: fvg.bottom,
                zoneType: fvg.type,
                time: fvgTime
              }).catch(e => console.error("Draw FVG failed:", e));
            });
          }

          if (signal !== 'NONE' && signal !== 'CLOSE_ALL' && (now - lastTradeTimeRef.current > 2000)) {
            lastTradeTimeRef.current = now;
            console.log(`🚀 APP BRAIN SIGNAL: ${signal} | Price: ${price} | SL: ${slPrice} | TP: ${tpPrice}`);
            
            // 1. Send the trade execution command
            placeOrder({
              symbol: accountData.ea_symbol || 'XAUUSD',
              type: signal,
              lots: 0,
              sl: slPrice,
              tp: tpPrice
            }).catch(e => console.error("App brain trade execution failed:", e));
            
          } else if (signal === 'CLOSE_ALL' && (now - lastTradeTimeRef.current > 2000)) {
            lastTradeTimeRef.current = now;
            console.log(`🚀 APP BRAIN SIGNAL: CLOSE_ALL`);
            placeOrder({
              symbol: accountData.ea_symbol || 'XAUUSD',
              type: 'CLOSE_ALL',
              lots: 0,
              sl: 0,
              tp: 0
            }).catch(e => console.error("App brain close execution failed:", e));
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
