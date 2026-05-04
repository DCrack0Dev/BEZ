//+------------------------------------------------------------------+
//|                                              ScalpKing_EA_v2.mq5 |
//|                                        Your Trading Bot Platform |
//|                     Scalper: Gold (XAU/USD) + Indices (US30/NAS) |
//|                    Strategy: EMA Crossover + Bollinger Squeeze   |
//|                          Timeframes: M5, M15, H1, H4               |
//+------------------------------------------------------------------+
#property copyright   "FxScalpKing"
#property link        "https://fxscalpking.com"
#property version     "2.00"
#property strict

#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>
#include "FxScalpKing_HTTP.mqh"

//+------------------------------------------------------------------+
//| INPUT PARAMETERS                                                 |
//+------------------------------------------------------------------+
input string   ApiKey            = "FXSK-90e36448c3d1ef9d749aa155ba228541";
input double   LotSize           = 0.01;
input int      StopLoss_Points   = 150;
input int      TakeProfit_Points = 300;
input int      MaxOpenTrades     = 30;
input int      MagicNumber       = 20250101;
input int      FastEMA_Period    = 8;
input int      SlowEMA_Period    = 21;
input int      BB_Period         = 20;
input double   BB_Deviation      = 2.0;
input double   SqueezeThreshold  = 0.002;
input bool     UseSessionFilter  = true;
input int      SessionStartHour  = 7;
input int      SessionEndHour    = 20;
input double   RetraceMaxFib     = 61.8;
input bool     UseTrailingStop   = true;
input int      HeartbeatInterval  = 30;

//+------------------------------------------------------------------+
//| GLOBAL VARIABLES                                                 |
//+------------------------------------------------------------------+
CTrade         trade;
CPositionInfo  posInfo;

int            handle_FastEMA_M5, handle_SlowEMA_M5;
int            handle_BB_M5;
int            handle_RSI_M5, handle_RSI7_M5;
int            handle_ATR_M5, handle_ATR_M15, handle_ATR_H1;

double         fastEMA_M5[], slowEMA_M5[];
double         bb_upper[], bb_lower[], bb_middle[];
double         rsi7_M5[];

bool           licenseValid      = false;
bool           isPaused          = false;
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
   
   // Server URL is configured in FxScalpKing_HTTP.mqh for Render server
   FxScalpKing.SetApiKey(ApiKey);

   if(!FxScalpKing.ValidateLicense(licenseExpiry, licensePlan))
   {
      Alert("❌ Invalid or expired API Key.");
      return INIT_FAILED;
   }
   licenseValid = true;
   Print("✅ License validated. Plan: ", licensePlan, " | Expires: ", licenseExpiry);

   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetDeviationInPoints(10);

   // Chart Styling (White BG, Blue/Red Candles)
   ChartSetInteger(0, CHART_MODE, CHART_CANDLES);
   ChartSetInteger(0, CHART_COLOR_BACKGROUND, clrWhite);
   ChartSetInteger(0, CHART_COLOR_FOREGROUND, clrBlack);
   ChartSetInteger(0, CHART_COLOR_GRID, clrWhite);
   ChartSetInteger(0, CHART_SHOW_GRID, false);
   ChartSetInteger(0, CHART_COLOR_CHART_UP, clrBlue);
   ChartSetInteger(0, CHART_COLOR_CHART_DOWN, clrRed);
   ChartSetInteger(0, CHART_COLOR_CANDLE_BULL, clrBlue);
   ChartSetInteger(0, CHART_COLOR_CANDLE_BEAR, clrRed);
   
   ChartSetInteger(0, CHART_SHOW_TRADE_LEVELS, true);
   ChartSetInteger(0, CHART_SHOW_TRADE_HISTORY, true);
   ChartSetInteger(0, CHART_SHOW_OBJECT_DESCR, false);

   ChartRedraw();

   // Initialize Indicators (only timeframes used by mobile app)
   handle_FastEMA_M5 = iMA(_Symbol, PERIOD_M5, FastEMA_Period, 0, MODE_EMA, PRICE_CLOSE);
   handle_SlowEMA_M5 = iMA(_Symbol, PERIOD_M5, SlowEMA_Period, 0, MODE_EMA, PRICE_CLOSE);
   handle_BB_M5      = iBands(_Symbol, PERIOD_M5, BB_Period, 0, BB_Deviation, PRICE_CLOSE);
   handle_RSI_M5     = iRSI(_Symbol, PERIOD_M5, 14, PRICE_CLOSE);
   handle_RSI7_M5    = iRSI(_Symbol, PERIOD_M5, 7, PRICE_CLOSE);
   handle_ATR_M5     = iATR(_Symbol, PERIOD_M5, 14);
   handle_ATR_M15    = iATR(_Symbol, PERIOD_M15, 14);
   handle_ATR_H1     = iATR(_Symbol, PERIOD_H1, 14);

   EventSetTimer(HeartbeatInterval);
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
   IndicatorRelease(handle_RSI_M5);
   IndicatorRelease(handle_RSI7_M5);
   IndicatorRelease(handle_ATR_M5);
   IndicatorRelease(handle_ATR_M15);
   IndicatorRelease(handle_ATR_H1);
   Print("=== ", EA_Name, " Stopped ===");
}

//+------------------------------------------------------------------+
//| MAIN TICK FUNCTION                                               |
//+------------------------------------------------------------------+
void OnTick()
{
   if(!licenseValid) return;
   
   CleanHistoryText();
   SendHeartbeat();

   if(!GetIndicatorData()) return;
   UpdateSMCZones();
}

//+------------------------------------------------------------------+
//| EXPERT TIMER                                                     |
//+------------------------------------------------------------------+
void OnTimer()
{
   if(!licenseValid) return;
   SendHeartbeat();
}

//+------------------------------------------------------------------+
//| CLEANUP HISTORY OBJECTS                                          |
//+------------------------------------------------------------------+
void CleanHistoryText()
{
   for(int i = ObjectsTotal(0, 0, -1) - 1; i >= 0; i--)
   {
      string name = ObjectName(0, i, 0, -1);
      if(StringFind(name, "#") == 0)
      {
         int type = (int)ObjectGetInteger(0, name, OBJPROP_TYPE);
         if(type == OBJ_TEXT || type == OBJ_LABEL) ObjectDelete(0, name);
      }
   }
}

//+------------------------------------------------------------------+
//| UPDATE SMC ZONES (BACKEND DRIVEN)                                |
//+------------------------------------------------------------------+
void UpdateSMCZones()
{
   static datetime lastZoneUpdate = 0;
   datetime now = TimeCurrent();
   if (now - lastZoneUpdate < 60) return;

   // Cleanup old zones
   for(int i = ObjectsTotal(0, 0, OBJ_RECTANGLE) - 1; i >= 0; i--)
   {
      string name = ObjectName(0, i, 0, OBJ_RECTANGLE);
      if(StringFind(name, "SMC_") == 0) ObjectDelete(0, name);
   }
   for(int i = ObjectsTotal(0, 0, OBJ_TEXT) - 1; i >= 0; i--)
   {
      string name = ObjectName(0, i, 0, OBJ_TEXT);
      if(StringFind(name, "SMC_LBL_") == 0) ObjectDelete(0, name);
   }
   for(int i = ObjectsTotal(0, 0, OBJ_TREND) - 1; i >= 0; i--)
   {
      string name = ObjectName(0, i, 0, OBJ_TREND);
      if(StringFind(name, "SMC_KL_") == 0) ObjectDelete(0, name);
   }

   // SMC zones are handled by the backend and sent via DRAW commands
   // The EA receives DRAW commands from the backend and renders them
   // This ensures consistency between EA chart and mobile app
   
   lastZoneUpdate = now;
   ChartRedraw();
}

//+------------------------------------------------------------------+
//| HEARTBEAT & SYNC                                                 |
//+------------------------------------------------------------------+
void SendHeartbeat()
{
   datetime now = TimeCurrent();
   if(now - lastHeartbeat < HeartbeatInterval) return;

   if(!GetIndicatorData()) {
      Print("❌ [EA] Failed to get indicator data for heartbeat");
      return;
   }
   
   double currentPrice = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   if(currentPrice <= 0) {
      Print("❌ [EA] Invalid price data for heartbeat");
      return;
   }
   
   double atr[]; 
   int copied = CopyBuffer(handle_ATR_M5, 0, 0, 1, atr);
   double atr_val = (copied > 0) ? atr[0] : 0;
   
   int spread = (int)SymbolInfoInteger(_Symbol, SYMBOL_SPREAD);
   long tickVol = iVolume(_Symbol, PERIOD_M5, 0);
   
   // Ensure arrays have data before accessing [0]
   double fEMA = (ArraySize(fastEMA_M5) > 0) ? fastEMA_M5[0] : 0;
   double sEMA = (ArraySize(slowEMA_M5) > 0) ? slowEMA_M5[0] : 0;
   double bbu = (ArraySize(bb_upper) > 0) ? bb_upper[0] : 0;
   double bbl = (ArraySize(bb_lower) > 0) ? bb_lower[0] : 0;
   double r7 = (ArraySize(rsi7_M5) > 0) ? rsi7_M5[0] : 0;

   // Enhanced logging
   double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   double profit = AccountInfoDouble(ACCOUNT_PROFIT);
   int positions = PositionsTotal();
   
   Print("📊 [EA] Market Data - Price: ", DoubleToString(currentPrice, 5), 
         " | EMA: ", DoubleToString(fEMA, 5), "/", DoubleToString(sEMA, 5),
         " | RSI: ", DoubleToString(r7, 2),
         " | ATR: ", DoubleToString(atr_val, 5));
   
   Print("💰 [EA] Account - Balance: ", DoubleToString(balance, 2),
         " | Equity: ", DoubleToString(equity, 2),
         " | Profit: ", DoubleToString(profit, 2),
         " | Positions: ", IntegerToString(positions));
   
   Print("📡 [EA] Sending heartbeat to backend...");
   
   FxScalpKing.SetMarketData(currentPrice, fEMA, sEMA, bbu, bbl, r7, atr_val, 0, spread, tickVol);

   string commands[];
   if(FxScalpKing.SendHeartbeat(commands))
   {
      lastHeartbeat = now;
      Print("✅ [EA] Heartbeat sent successfully. Commands received: ", ArraySize(commands));
      
      // Log received commands
      for(int i = 0; i < ArraySize(commands); i++) {
         Print("🎯 [EA] Command received: ", commands[i]);
         ProcessCommand(commands[i]);
      }
   } else {
      Print("❌ [EA] Failed to send heartbeat to server");
   }
}

//+------------------------------------------------------------------+
//| PROCESS APP COMMANDS                                             |
//+------------------------------------------------------------------+
void ProcessCommand(string cmd)
{
   string parts[];
   int numParts = StringSplit(cmd, '|', parts);
   if(numParts == 0) return;
   
   string action = parts[0];
   
   // Enhanced command logging
   Print("🎯 [EA] Processing command: ", action);
   
   if(action == "BUY" && numParts >= 3) {
      double price = StringToDouble(parts[1]);
      double sl = StringToDouble(parts[2]);
      Print("💹 [EA] BUY command - Price: ", DoubleToString(price, 5), " SL: ", DoubleToString(sl, 5));
      OpenBuy(price, sl);
   }
   else if(action == "SELL" && numParts >= 3) {
      double price = StringToDouble(parts[1]);
      double sl = StringToDouble(parts[2]);
      Print("📉 [EA] SELL command - Price: ", DoubleToString(price, 5), " SL: ", DoubleToString(sl, 5));
      OpenSell(price, sl);
   }
   else if(action == "CLOSE_ALL") {
      Print("❌ [EA] CLOSE_ALL command - Closing all positions");
      CloseAllTrades();
   }
   else if(action == "SET_TF" && numParts >= 2) {
      Print("⏱️ [EA] SET_TF command - New timeframe: ", parts[1]);
      FxScalpKing.SetRequestedTf(parts[1]);
   }
   else if(StringFind(action, "CLOSE_TICKET_") == 0) {
      ulong ticket = (ulong)StringToInteger(StringSubstr(action, 13));
      Print("🎫 [EA] CLOSE_TICKET command - Ticket: ", IntegerToString((long)ticket));
      CloseTrade(ticket);
   }
   else if((action == "DRAW_OB" || action == "DRAW_FVG" || action == "DRAW_KEY_LEVEL" || action == "DRAW_KL") && numParts >= 5) {
      double top = StringToDouble(parts[1]);
      double bottom = StringToDouble(parts[2]);
      string zoneType = parts[3];
      datetime zTime = (datetime)StringToInteger(parts[4]);

      Print("📐 [EA] DRAW command - ", action, " | Type: ", zoneType, " | Top: ", DoubleToString(top, 5), " | Bottom: ", DoubleToString(bottom, 5));

      if(!IsSignificantPOI(top, bottom, zTime, action)) {
         Print("⚠️ [EA] POI not significant, skipping");
         return;
      }

      bool isBull = (zoneType == "BULLISH" || zoneType == "BULL");
      if(action == "DRAW_KEY_LEVEL" || action == "DRAW_KL")
      {
         double lvl = (top > 0.0 ? top : bottom);
         if(lvl <= 0.0) return;
         Print("📍 [EA] Drawing key level at: ", DoubleToString(lvl, 5));
         DrawKeyLevel("SMC_KL_" + IntegerToString((int)zTime), lvl, isBull ? clrLimeGreen : clrTomato, "KL");
      }
      else
      {
         color clr = isBull ? clrForestGreen : clrFireBrick;
         if(action == "DRAW_FVG") clr = isBull ? clrRoyalBlue : clrMediumVioletRed;
         Print("🔲 [EA] Drawing zone: ", action, " | Color: ", isBull ? "Bullish" : "Bearish");
         DrawZone("SMC_" + action + "_" + parts[4], zTime, top, TimeCurrent() + 3600, bottom, clr);
      }
   }
   else {
      Print("❓ [EA] Unknown command: ", action);
   }
}

//+------------------------------------------------------------------+
//| HELPER FUNCTIONS                                                 |
//+------------------------------------------------------------------+
bool GetIndicatorData()
{
   ArraySetAsSeries(fastEMA_M5, true); ArraySetAsSeries(slowEMA_M5, true);
   ArraySetAsSeries(bb_upper, true); ArraySetAsSeries(bb_lower, true); ArraySetAsSeries(bb_middle, true);
   ArraySetAsSeries(rsi7_M5, true);
   
   return (CopyBuffer(handle_FastEMA_M5, 0, 0, 3, fastEMA_M5) == 3 &&
           CopyBuffer(handle_SlowEMA_M5, 0, 0, 3, slowEMA_M5) == 3 &&
           CopyBuffer(handle_BB_M5, UPPER_BAND, 0, 3, bb_upper) == 3 &&
           CopyBuffer(handle_BB_M5, LOWER_BAND, 0, 3, bb_lower) == 3 &&
           CopyBuffer(handle_RSI7_M5, 0, 0, 3, rsi7_M5) == 3);
}

void DrawZone(string name, datetime t1, double p1, datetime t2, double p2, color clr)
{
   if(p1 <= 0.0 || p2 <= 0.0) return;
   
   // Check if object already exists with same properties to avoid spam
   if(ObjectFind(0, name) >= 0) {
      double existing_top = ObjectGetDouble(0, name, OBJPROP_PRICE);
      double existing_bottom = ObjectGetDouble(0, name, OBJPROP_PRICE, 1);
      datetime existing_time1 = (datetime)ObjectGetInteger(0, name, OBJPROP_TIME);
      datetime existing_time2 = (datetime)ObjectGetInteger(0, name, OBJPROP_TIME, 1);
      color existing_color = (color)ObjectGetInteger(0, name, OBJPROP_COLOR);
      
      // If properties are the same, don't redraw
      if(MathAbs(existing_top - MathMax(p1, p2)) < 0.001 &&
         MathAbs(existing_bottom - MathMin(p1, p2)) < 0.001 &&
         MathAbs(existing_time1 - t1) < 60 &&
         MathAbs(existing_time2 - t2) < 60 &&
         existing_color == clr) {
         return;
      }
   }
   
   double top = MathMax(p1, p2);
   double bottom = MathMin(p1, p2);
   if(t1 <= 0) t1 = TimeCurrent() - 1800;
   if(t2 <= t1) t2 = t1 + 3600;

   ObjectDelete(0, name);
   ObjectCreate(0, name, OBJ_RECTANGLE, 0, t1, top, t2, bottom);
   ObjectSetInteger(0, name, OBJPROP_COLOR, clr);
   ObjectSetInteger(0, name, OBJPROP_FILL, true);
   ObjectSetInteger(0, name, OBJPROP_BACK, true);
   ObjectSetInteger(0, name, OBJPROP_WIDTH, 1);
   ObjectSetInteger(0, name, OBJPROP_STYLE, STYLE_SOLID);
}

void DrawKeyLevel(string name, double levelPrice, color clr, string txt)
{
   if(levelPrice <= 0.0) return;
   ObjectDelete(0, name);
   ObjectCreate(0, name, OBJ_HLINE, 0, 0, levelPrice);
   ObjectSetInteger(0, name, OBJPROP_COLOR, clr);
   ObjectSetInteger(0, name, OBJPROP_STYLE, STYLE_DOT);
   ObjectSetInteger(0, name, OBJPROP_WIDTH, 1);
   ObjectSetString(0, name, OBJPROP_TEXT, txt);
}

bool IsSignificantPOI(double top, double bottom, double zTime, string action)
{
   double pTop = MathMax(top, bottom);
   double pBottom = MathMin(top, bottom);
   double zoneHeight = MathAbs(pTop - pBottom);

   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double point = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   if(point <= 0.0) point = 0.01;

   double atrBuf[];
   double atr = 0.0;
   if(CopyBuffer(handle_ATR_M5, 0, 0, 1, atrBuf) > 0) atr = atrBuf[0];
   if(atr <= 0.0) atr = point * 120.0;

   double nearestDist = MathMin(MathAbs(pTop - bid), MathAbs(pBottom - bid));
   double minHeight = MathMax(point * 10.0, atr * 0.06);
   double maxHeight = atr * 1.8;
   double maxDist = atr * 5.0;
   int ageSec = (int)(TimeCurrent() - zTime);

   // Key levels can be thin, but should still be near current context.
   if(action == "DRAW_KEY_LEVEL" || action == "DRAW_KL")
      return nearestDist <= atr * 6.0 && ageSec <= 3 * 86400;

   if(zoneHeight < minHeight) return false;
   if(zoneHeight > maxHeight) return false;
   if(nearestDist > maxDist) return false;
   if(ageSec > 3 * 86400) return false;
   return true;
}

void OpenBuy(double sl, double tp) {
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   if(trade.Buy(LotSize, _Symbol, ask, sl, tp, EA_Name))
      FxScalpKing.NotifyTradeExecuted(trade.ResultOrder(), "BUY", LotSize, ask, sl, tp, AccountInfoDouble(ACCOUNT_PROFIT));
}

void OpenSell(double sl, double tp) {
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   if(trade.Sell(LotSize, _Symbol, bid, sl, tp, EA_Name))
      FxScalpKing.NotifyTradeExecuted(trade.ResultOrder(), "SELL", LotSize, bid, sl, tp, AccountInfoDouble(ACCOUNT_PROFIT));
}

void CloseAllTrades() {
   for(int i = PositionsTotal()-1; i >= 0; i--)
      if(posInfo.SelectByIndex(i) && posInfo.Magic() == MagicNumber) trade.PositionClose(posInfo.Ticket());
}

bool CloseTrade(ulong ticket) {
   return trade.PositionClose(ticket);
}

bool IsWithinSession() {
   MqlDateTime dt; TimeToStruct(TimeCurrent(), dt);
   return (dt.hour >= SessionStartHour && dt.hour < SessionEndHour);
}

string JsonEscape(string value)
{
   string out = value;
   StringReplace(out, "\\", "\\\\");
   StringReplace(out, "\"", "\\\"");
   StringReplace(out, "\r", " ");
   StringReplace(out, "\n", " ");
   return out;
}

void SendPositionHistorySync(long positionId)
{
   if(positionId <= 0) return;

   // Sync only the just-closed position (not all history)
   datetime fromDate = TimeCurrent() - (30 * 86400);
   if(!HistorySelect(fromDate, TimeCurrent())) return;
   
   int total = HistoryDealsTotal();
   string json = "{\"apiKey\":\"" + ApiKey + "\",\"deals\":[";
   bool first = true;
   int syncedCount = 0;
   
   for(int i = 0; i < total; i++)
   {
      ulong ticket = HistoryDealGetTicket(i);
      if(ticket <= 0) continue;
      
      long magic = HistoryDealGetInteger(ticket, DEAL_MAGIC);
      if(magic != MagicNumber) continue;

      long dealPosId = HistoryDealGetInteger(ticket, DEAL_POSITION_ID);
      if(dealPosId != positionId) continue;
      
      long type = HistoryDealGetInteger(ticket, DEAL_TYPE);
      long entry = HistoryDealGetInteger(ticket, DEAL_ENTRY);
      
      // We only care about entries (to get open price/time) and exits (to get close price/profit)
      if(entry != DEAL_ENTRY_IN && entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_OUT_BY) continue;
      
      if(!first) json += ",";
      first = false;
      
      json += "{";
      json += "\"ticket\":" + IntegerToString(HistoryDealGetInteger(ticket, DEAL_POSITION_ID)) + ",";
      json += "\"deal_ticket\":" + IntegerToString(ticket) + ",";
      json += "\"time\":" + IntegerToString(HistoryDealGetInteger(ticket, DEAL_TIME)) + ",";
      json += "\"type\":\"" + (type == DEAL_TYPE_BUY ? "BUY" : "SELL") + "\",";
      json += "\"entry\":\"" + (entry == DEAL_ENTRY_IN ? "IN" : "OUT") + "\",";
      json += "\"symbol\":\"" + JsonEscape(HistoryDealGetString(ticket, DEAL_SYMBOL)) + "\",";
      json += "\"volume\":" + DoubleToString(HistoryDealGetDouble(ticket, DEAL_VOLUME), 2) + ",";
      json += "\"price\":" + DoubleToString(HistoryDealGetDouble(ticket, DEAL_PRICE), 5) + ",";
      json += "\"sl\":" + DoubleToString(HistoryDealGetDouble(ticket, DEAL_SL), 5) + ",";
      json += "\"tp\":" + DoubleToString(HistoryDealGetDouble(ticket, DEAL_TP), 5) + ",";
      json += "\"deal_reason\":" + IntegerToString((int)HistoryDealGetInteger(ticket, DEAL_REASON)) + ",";
      json += "\"profit\":" + DoubleToString(HistoryDealGetDouble(ticket, DEAL_PROFIT), 2) + ",";
      json += "\"commission\":" + DoubleToString(HistoryDealGetDouble(ticket, DEAL_COMMISSION), 2) + ",";
      json += "\"swap\":" + DoubleToString(HistoryDealGetDouble(ticket, DEAL_SWAP), 2) + ",";
      json += "\"comment\":\"" + JsonEscape(HistoryDealGetString(ticket, DEAL_COMMENT)) + "\"";
      json += "}";
      syncedCount++;
   }
   
   json += "]}";
   if(syncedCount > 0) {
      if(FxScalpKing.SyncHistory(json)) {
         Print("📊 Journal Sync: Position ", positionId, " synced with ", syncedCount, " deals.");
      } else {
         Print("❌ Journal Sync: Failed for position ", positionId);
      }
   }
}

void SendHistorySync()
{
   // Manual fallback full sync (not used in heartbeat)
   datetime fromDate = TimeCurrent() - (30 * 86400);
   if(!HistorySelect(fromDate, TimeCurrent())) return;
   int total = HistoryDealsTotal();
   if(total <= 0) return;

   long latestPosId = 0;
   for(int i = total - 1; i >= 0; i--)
   {
      ulong ticket = HistoryDealGetTicket(i);
      if(ticket <= 0) continue;
      if(HistoryDealGetInteger(ticket, DEAL_MAGIC) != MagicNumber) continue;
      latestPosId = HistoryDealGetInteger(ticket, DEAL_POSITION_ID);
      if(latestPosId > 0) break;
   }
   if(latestPosId > 0) SendPositionHistorySync(latestPosId);
}

void OnTradeTransaction(const MqlTradeTransaction &trans, const MqlTradeRequest &request, const MqlTradeResult &result)
{
   if(!licenseValid) return;
   if(trans.type != TRADE_TRANSACTION_DEAL_ADD) return;
   if(trans.deal <= 0) return;
   if(!HistoryDealSelect(trans.deal)) return;

   long magic = HistoryDealGetInteger(trans.deal, DEAL_MAGIC);
   if(magic != MagicNumber) return;

   long entry = HistoryDealGetInteger(trans.deal, DEAL_ENTRY);
   if(entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_OUT_BY) return;

   long posId = HistoryDealGetInteger(trans.deal, DEAL_POSITION_ID);
   SendPositionHistorySync(posId);
}
//+------------------------------------------------------------------+
