//+------------------------------------------------------------------+
//|                                                 ScalpKing_EA.mq5 |
//|                                        Your Trading Bot Platform |
//|                     Scalper: Gold (XAU/USD) + Indices (US30/NAS) |
//|                    Strategy: EMA Crossover + Bollinger Squeeze   |
//|                          Timeframes: M1 confirmation + M5 signal |
//+------------------------------------------------------------------+
#property copyright   "FxScalpKing"
#property link        "https://fxscalpking.com"
#property version     "2.00"
#property strict

#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>
#include "FxScalpKing_HTTP.mqh"

//+------------------------------------------------------------------+
//| INPUT PARAMETERS (Configurable from App or MT5 Settings)        |
//+------------------------------------------------------------------+

// --- LICENSE & CONNECTION ---
input string   ApiKey            = "FXSK-90e36448c3d1ef9d749aa155ba228541"; // Your API Key (from FxScalpKing App)
input string   ServerURL         = "https://liquibot-back.onrender.com"; // Backend Server URL (NO trailing slash)

// --- TRADE SETTINGS ---
input double   LotSize           = 0.01;        // Fixed Lot Size
input int      StopLoss_Points   = 150;         // Stop Loss in Points
input int      TakeProfit_Points = 300;         // Take Profit in Points
input int      MaxOpenTrades     = 3;           // Max simultaneous trades
input int      MagicNumber       = 20250101;    // EA Identifier

// --- EMA SETTINGS ---
input int      FastEMA_Period    = 8;           // Fast EMA Period
input int      SlowEMA_Period    = 21;          // Slow EMA Period

// --- BOLLINGER BAND SETTINGS ---
input int      BB_Period         = 20;          // Bollinger Band Period
input double   BB_Deviation      = 2.0;         // Bollinger Band Deviation
input double   SqueezeThreshold  = 0.002;       // Squeeze threshold (% of price)

// --- SESSION FILTER ---
input bool     UseSessionFilter  = true;        // Only trade during active sessions
input int      SessionStartHour  = 7;           // Session Start (Server Time)
input int      SessionEndHour    = 20;          // Session End (Server Time)

// --- TRAILING STOP ---
input bool     UseTrailingStop   = true;        // Enable Trailing Stop
input int      TrailingStop_Points = 80;        // Trailing Stop Distance in Points

// --- HEARTBEAT SETTINGS ---
input int      HeartbeatInterval  = 3;          // Heartbeat interval in seconds

//+------------------------------------------------------------------+
//| GLOBAL VARIABLES                                                 |
//+------------------------------------------------------------------+
CTrade         trade;
CPositionInfo  posInfo;

int            handle_FastEMA_M5, handle_SlowEMA_M5;
int            handle_FastEMA_M1, handle_SlowEMA_M1;
int            handle_BB_M5;

double         fastEMA_M5[], slowEMA_M5[];
double         fastEMA_M1[], slowEMA_M1[];
double         bb_upper[], bb_lower[], bb_middle[];

bool           licenseValid      = false;
datetime       lastBarTime_M5   = 0;
datetime       lastBarTime_M1   = 0;
datetime       lastHeartbeat    = 0;

string         EA_Name           = "FxScalpKing EA v2.0";
string         licenseExpiry     = "";
string         licensePlan       = "";

//+------------------------------------------------------------------+
//| EXPERT INITIALIZATION                                            |
//+------------------------------------------------------------------+
int OnInit()
{
   Print("=== ", EA_Name, " Starting ===");
   Print("📡 Server URL: ", ServerURL);

   // --- Configure HTTP Client ---
   FxScalpKing.SetServerUrl(ServerURL);
   FxScalpKing.SetApiKey(ApiKey);

   // --- License Validation ---
   if(!ValidateLicense())
   {
      Alert("❌ Invalid or expired API Key. Please check your subscription at fxscalpking.com");
      return INIT_FAILED;
   }
   licenseValid = true;
   Print("✅ License validated. Plan: ", licensePlan, " | Expires: ", licenseExpiry);

   // --- Set Magic Number ---
   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetDeviationInPoints(10);

   // --- Initialize Indicators on M5 ---
   handle_FastEMA_M5 = iMA(_Symbol, PERIOD_M5, FastEMA_Period, 0, MODE_EMA, PRICE_CLOSE);
   handle_SlowEMA_M5 = iMA(_Symbol, PERIOD_M5, SlowEMA_Period, 0, MODE_EMA, PRICE_CLOSE);
   handle_BB_M5      = iBands(_Symbol, PERIOD_M5, BB_Period, 0, BB_Deviation, PRICE_CLOSE);

   // --- Initialize Indicators on M1 ---
   handle_FastEMA_M1 = iMA(_Symbol, PERIOD_M1, FastEMA_Period, 0, MODE_EMA, PRICE_CLOSE);
   handle_SlowEMA_M1 = iMA(_Symbol, PERIOD_M1, SlowEMA_Period, 0, MODE_EMA, PRICE_CLOSE);

   if(handle_FastEMA_M5 == INVALID_HANDLE || handle_SlowEMA_M5 == INVALID_HANDLE ||
      handle_BB_M5 == INVALID_HANDLE || handle_FastEMA_M1 == INVALID_HANDLE ||
      handle_SlowEMA_M1 == INVALID_HANDLE)
   {
      Alert("❌ Failed to initialize indicators. Check symbol name.");
      return INIT_FAILED;
   }

   Print("✅ Indicators initialized on M1 + M5.");
   Print("📊 Symbol: ", _Symbol);
   Print("📦 Lot Size: ", LotSize);
   Print("🛑 Stop Loss: ", StopLoss_Points, " points");
   Print("🎯 Take Profit: ", TakeProfit_Points, " points");

   // --- Set Timer for Heartbeat (every HeartbeatInterval seconds) ---
   EventSetTimer(HeartbeatInterval);

   // --- Send initial heartbeat ---
   SendHeartbeat();

   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
//| EXPERT DEINITIALIZATION                                          |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
   IndicatorRelease(handle_FastEMA_M5);
   IndicatorRelease(handle_SlowEMA_M5);
   IndicatorRelease(handle_BB_M5);
   IndicatorRelease(handle_FastEMA_M1);
   IndicatorRelease(handle_SlowEMA_M1);
   Print("=== ", EA_Name, " Stopped ===");
}

//+------------------------------------------------------------------+
//| EXPERT TIMER (Heartbeat)                                         |
//+------------------------------------------------------------------+
void OnTimer()
{
   if(!licenseValid) return;
   SendHeartbeat();
}

//+------------------------------------------------------------------+
//| MAIN TICK FUNCTION                                               |
//+------------------------------------------------------------------+
void OnTick()
{
   if(!licenseValid) return;

   // --- Session Filter ---
   if(UseSessionFilter && !IsWithinSession()) return;

   // --- Manage Trailing Stops on every tick ---
   if(UseTrailingStop) ManageTrailingStop();

   // --- Process Heartbeat & Commands ---
   SendHeartbeat();

   // --- Get M5 Data ---
   if(!GetIndicatorData()) return;

   // The brain is now on the app. We just gather data and let Heartbeat send it.
   // We no longer automatically open trades here.
}

//+------------------------------------------------------------------+
//| GET INDICATOR DATA                                               |
//+------------------------------------------------------------------+
bool GetIndicatorData()
{
   ArraySetAsSeries(fastEMA_M5, true);
   ArraySetAsSeries(slowEMA_M5, true);
   ArraySetAsSeries(fastEMA_M1, true);
   ArraySetAsSeries(slowEMA_M1, true);
   ArraySetAsSeries(bb_upper,   true);
   ArraySetAsSeries(bb_lower,   true);
   ArraySetAsSeries(bb_middle,  true);

   if(CopyBuffer(handle_FastEMA_M5, 0, 0, 3, fastEMA_M5) < 3) return false;
   if(CopyBuffer(handle_SlowEMA_M5, 0, 0, 3, slowEMA_M5) < 3) return false;
   if(CopyBuffer(handle_BB_M5, UPPER_BAND,  0, 3, bb_upper)  < 3) return false;
   if(CopyBuffer(handle_BB_M5, LOWER_BAND,  0, 3, bb_lower)  < 3) return false;
   if(CopyBuffer(handle_BB_M5, BASE_LINE,   0, 3, bb_middle) < 3) return false;
   if(CopyBuffer(handle_FastEMA_M1, 0, 0, 3, fastEMA_M1) < 3) return false;
   if(CopyBuffer(handle_SlowEMA_M1, 0, 0, 3, slowEMA_M1) < 3) return false;

   return true;
}

//+------------------------------------------------------------------+
//| M5 SIGNAL: EMA Crossover                                        |
//| Returns: 1 = BUY, -1 = SELL, 0 = NO SIGNAL                     |
//+------------------------------------------------------------------+
int GetM5Signal()
{
   // Bullish crossover: fast crossed above slow on previous bar
   bool bullishCross = (fastEMA_M5[1] > slowEMA_M5[1]) && (fastEMA_M5[2] <= slowEMA_M5[2]);
   // Bearish crossover: fast crossed below slow on previous bar
   bool bearishCross = (fastEMA_M5[1] < slowEMA_M5[1]) && (fastEMA_M5[2] >= slowEMA_M5[2]);

   if(bullishCross) return 1;
   if(bearishCross) return -1;
   return 0;
}

//+------------------------------------------------------------------+
//| M1 CONFIRMATION: EMA Alignment                                  |
//| Returns: 1 = BUY confirm, -1 = SELL confirm, 0 = NONE          |
//+------------------------------------------------------------------+
int GetM1Confirmation()
{
   bool bullish = fastEMA_M1[0] > slowEMA_M1[0];
   bool bearish = fastEMA_M1[0] < slowEMA_M1[0];

   if(bullish) return 1;
   if(bearish) return -1;
   return 0;
}

//+------------------------------------------------------------------+
//| BOLLINGER SQUEEZE DETECTION                                      |
//| Squeeze = Bands are narrow relative to price (low volatility)   |
//+------------------------------------------------------------------+
bool IsBollingerSqueeze()
{
   double bandWidth = (bb_upper[1] - bb_lower[1]) / bb_middle[1];
   return (bandWidth <= SqueezeThreshold);
}

//+------------------------------------------------------------------+
//| OPEN BUY TRADE                                                   |
//+------------------------------------------------------------------+
void OpenBuy()
{
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED))
   {
      Print("❌ Algo Trading is disabled in MT5 terminal. Please click the 'Algo Trading' button at the top.");
      return;
   }
   if(!AccountInfoInteger(ACCOUNT_TRADE_ALLOWED))
   {
      Print("❌ Trading is disabled for this account by the broker.");
      return;
   }
   if(!AccountInfoInteger(ACCOUNT_TRADE_EXPERT))
   {
      Print("❌ Algo Trading is disabled for this account by the broker.");
      return;
   }
   if((ENUM_SYMBOL_TRADE_MODE)SymbolInfoInteger(_Symbol, SYMBOL_TRADE_MODE) == SYMBOL_TRADE_MODE_DISABLED)
   {
      Print("❌ Trading is disabled for symbol ", _Symbol);
      return;
   }

   double minVolume = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxVolume = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   double stepVolume = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   
   double safeLotSize = LotSize;
   if(safeLotSize < minVolume) safeLotSize = minVolume;
   if(safeLotSize > maxVolume) safeLotSize = maxVolume;
   
   // Align to volume step
   int steps = (int)MathRound(safeLotSize / stepVolume);
   safeLotSize = steps * stepVolume;

   double ask    = SymbolInfoDouble(_Symbol, SYMBOL_ASK);

   double point  = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   double sl     = ask - StopLoss_Points * point;
   double tp     = ask + TakeProfit_Points * point;

   sl = NormalizeDouble(sl, _Digits);
   tp = NormalizeDouble(tp, _Digits);

   if(trade.Buy(safeLotSize, _Symbol, ask, sl, tp, EA_Name))
   {
      ulong ticket = trade.ResultOrder();
      Print("✅ BUY opened | Ticket: ", ticket, " | Price: ", ask, " | SL: ", sl, " | TP: ", tp);
      NotifyTradeExecuted(ticket, "BUY", safeLotSize, ask, sl, tp);
   }
   else
      Print("❌ BUY failed: ", trade.ResultRetcodeDescription());
}

//+------------------------------------------------------------------+
//| OPEN SELL TRADE                                                  |
//+------------------------------------------------------------------+
void OpenSell()
{
   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED))
   {
      Print("❌ Algo Trading is disabled in MT5 terminal. Please click the 'Algo Trading' button at the top.");
      return;
   }
   if(!AccountInfoInteger(ACCOUNT_TRADE_ALLOWED))
   {
      Print("❌ Trading is disabled for this account by the broker.");
      return;
   }
   if(!AccountInfoInteger(ACCOUNT_TRADE_EXPERT))
   {
      Print("❌ Algo Trading is disabled for this account by the broker.");
      return;
   }
   if((ENUM_SYMBOL_TRADE_MODE)SymbolInfoInteger(_Symbol, SYMBOL_TRADE_MODE) == SYMBOL_TRADE_MODE_DISABLED)
   {
      Print("❌ Trading is disabled for symbol ", _Symbol);
      return;
   }

   double minVolume = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxVolume = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   double stepVolume = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   
   double safeLotSize = LotSize;
   if(safeLotSize < minVolume) safeLotSize = minVolume;
   if(safeLotSize > maxVolume) safeLotSize = maxVolume;
   
   // Align to volume step
   int steps = (int)MathRound(safeLotSize / stepVolume);
   safeLotSize = steps * stepVolume;

   double bid    = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double point  = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   double sl     = bid + StopLoss_Points * point;
   double tp     = bid - TakeProfit_Points * point;

   sl = NormalizeDouble(sl, _Digits);
   tp = NormalizeDouble(tp, _Digits);

   if(trade.Sell(safeLotSize, _Symbol, bid, sl, tp, EA_Name))
   {
      ulong ticket = trade.ResultOrder();
      Print("✅ SELL opened | Ticket: ", ticket, " | Price: ", bid, " | SL: ", sl, " | TP: ", tp);
      NotifyTradeExecuted(ticket, "SELL", safeLotSize, bid, sl, tp);
   }
   else
      Print("❌ SELL failed: ", trade.ResultRetcodeDescription());
}

//+------------------------------------------------------------------+
//| CLOSE TRADE (Called from App command)                            |
//+------------------------------------------------------------------+
bool CloseTrade(ulong ticket)
{
   if(!PositionSelectByTicket(ticket))
   {
      Print("❌ Position not found: ", ticket);
      return false;
   }

   if(trade.PositionClose(ticket))
   {
      Print("✅ Position closed: ", ticket);
      NotifyTradeClosed(ticket);
      return true;
   }

   Print("❌ Failed to close position: ", ticket);
   return false;
}

//+------------------------------------------------------------------+
//| TRAILING STOP MANAGER                                            |
//+------------------------------------------------------------------+
void ManageTrailingStop()
{
   double point = SymbolInfoDouble(_Symbol, SYMBOL_POINT);

   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(!posInfo.SelectByIndex(i)) continue;
      if(posInfo.Symbol() != _Symbol) continue;
      if(posInfo.Magic() != MagicNumber) continue;

      double currentSL = posInfo.StopLoss();
      double openPrice = posInfo.PriceOpen();
      double tp = posInfo.TakeProfit();

      if(posInfo.PositionType() == POSITION_TYPE_BUY)
      {
         if(tp <= openPrice) continue; // Invalid TP for 20% calculation
         double distanceToTP = tp - openPrice;
         double activationPrice = openPrice + (distanceToTP * 0.20);
         
         double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
         
         // Start trailing only when price reaches 20% in profit to TP
         if(bid >= activationPrice)
         {
            double newSL = bid - TrailingStop_Points * point;
            newSL = NormalizeDouble(newSL, _Digits);

            if((currentSL == 0.0 || newSL > currentSL) && newSL > openPrice)
               trade.PositionModify(posInfo.Ticket(), newSL, posInfo.TakeProfit());
         }
      }
      else if(posInfo.PositionType() == POSITION_TYPE_SELL)
      {
         if(tp >= openPrice || tp == 0.0) continue; // Invalid TP for 20% calculation
         double distanceToTP = openPrice - tp;
         double activationPrice = openPrice - (distanceToTP * 0.20);
         
         double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
         
         // Start trailing only when price reaches 20% in profit to TP
         if(ask <= activationPrice)
         {
            double newSL = ask + TrailingStop_Points * point;
            newSL = NormalizeDouble(newSL, _Digits);

            if((currentSL == 0.0 || newSL < currentSL) && newSL < openPrice)
               trade.PositionModify(posInfo.Ticket(), newSL, posInfo.TakeProfit());
         }
      }
   }
}

//+------------------------------------------------------------------+
//| COUNT OPEN TRADES FOR THIS EA                                    |
//+------------------------------------------------------------------+
int CountOpenTrades()
{
   int count = 0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(!posInfo.SelectByIndex(i)) continue;
      if(posInfo.Symbol() == _Symbol && posInfo.Magic() == MagicNumber)
         count++;
   }
   return count;
}

//+------------------------------------------------------------------+
//| SESSION TIME FILTER                                              |
//+------------------------------------------------------------------+
bool IsWithinSession()
{
   MqlDateTime dt;
   TimeToStruct(TimeCurrent(), dt);
   return (dt.hour >= SessionStartHour && dt.hour < SessionEndHour);
}

//+------------------------------------------------------------------+
//| LICENSE VALIDATION (Backend Call)                                |
//+------------------------------------------------------------------+
bool ValidateLicense()
{
   if(ApiKey == "" || StringLen(ApiKey) < 8)
   {
      Print("❌ License check failed: empty or too short API key.");
      return false;
   }

   // Call backend to validate
   return FxScalpKing.ValidateLicense(licenseExpiry, licensePlan);
}

//+------------------------------------------------------------------+
//| SEND HEARTBEAT TO BACKEND                                         |
//+------------------------------------------------------------------+
void SendHeartbeat()
{
   datetime now = TimeCurrent();
   if(now - lastHeartbeat < HeartbeatInterval)
      return;

   // Update indicator data before sending heartbeat
   if(GetIndicatorData()) {
      double currentPrice = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      FxScalpKing.SetMarketData(currentPrice, fastEMA_M5[0], slowEMA_M5[0], bb_upper[0], bb_lower[0]);
   }

   string commands[];
   if(FxScalpKing.SendHeartbeat(commands))
   {
      lastHeartbeat = now;

      // Process any commands from app
      for(int i = 0; i < ArraySize(commands); i++)
      {
         Print("📱 App command received: ", commands[i]);
         // Process command (e.g., CLOSE_ALL, CLOSE_TICKET_123)
         ProcessCommand(commands[i]);
      }
   }
}

//+------------------------------------------------------------------+
//| PROCESS INDIVIDUAL COMMAND                                        |
//+------------------------------------------------------------------+
void ProcessCommand(string cmd)
{
   if(cmd == "CLOSE_ALL")
   {
      CloseAllTrades();
   }
   else if(StringFind(cmd, "CLOSE_TICKET_") == 0)
   {
      ulong ticket = (ulong)StringToInteger(StringSubstr(cmd, 13));
      CloseTrade(ticket);
   }
   else if(cmd == "BUY")
   {
      OpenBuy();
   }
   else if(cmd == "SELL")
   {
      OpenSell();
   }
   else if(cmd == "PAUSE")
   {
      Print("⏸ EA Paused by app");
      // Could set a global flag to pause trading
   }
   else if(cmd == "RESUME")
   {
      Print("▶ EA Resumed by app");
   }
}

//+------------------------------------------------------------------+
//| CLOSE ALL TRADES                                                 |
//+------------------------------------------------------------------+
void CloseAllTrades()
{
   for(int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if(!posInfo.SelectByIndex(i)) continue;
      if(posInfo.Symbol() != _Symbol) continue;
      if(posInfo.Magic() != MagicNumber) continue;

      trade.PositionClose(posInfo.Ticket());
      Print("✅ Closed all positions");
   }
}

//+------------------------------------------------------------------+
//| NOTIFY TRADE EXECUTED TO BACKEND                                  |
//+------------------------------------------------------------------+
void NotifyTradeExecuted(ulong ticket, string type, double volume, double price, double sl, double tp)
{
   double profit = AccountInfoDouble(ACCOUNT_PROFIT);
   FxScalpKing.NotifyTradeExecuted(ticket, type, volume, price, sl, tp, profit);
}

//+------------------------------------------------------------------+
//| NOTIFY TRADE CLOSED TO BACKEND                                    |
//+------------------------------------------------------------------+
void NotifyTradeClosed(ulong ticket)
{
   double profit = 0;
   if(PositionSelectByTicket(ticket))
   {
      profit = PositionGetDouble(POSITION_PROFIT);
   }
   FxScalpKing.NotifyTradeExecuted(ticket, "CLOSE", 0, 0, 0, 0, profit);
}

//+------------------------------------------------------------------+
//| ON TRADE TRANSACTION (optional: log fills to journal)            |
//+------------------------------------------------------------------+
void OnTradeTransaction(const MqlTradeTransaction &trans,
                        const MqlTradeRequest     &request,
                        const MqlTradeResult      &result)
{
   if(trans.type == TRADE_TRANSACTION_DEAL_ADD)
   {
      Print("📋 Deal executed | Ticket: ", trans.deal,
            " | Volume: ", trans.volume,
            " | Price: ", trans.price);
   }
}
//+------------------------------------------------------------------+
