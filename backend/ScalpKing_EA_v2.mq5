//+------------------------------------------------------------------+
//|                                              ScalpKing_EA_v2.mq5 |
//|                                        Your Trading Bot Platform |
//|                     Scalper: Gold (XAU/USD) + Indices (US30/NAS) |
//|                    Strategy: Long & Short SMC Strategy           |
//+------------------------------------------------------------------+
#property copyright   "FxScalpKing"
#property link        "https://fxscalpking.com"
#property version     "2.15"
#property strict

#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>
#include "FxScalpKing_HTTP.mqh"

//+------------------------------------------------------------------+
//| INPUT PARAMETERS                                                 |
//+------------------------------------------------------------------+
input string   ApiKey            = "FXSK-90e36448c3d1ef9d749aa155ba228541";
input string   ServerURL         = "https://liquibot-back.onrender.com";
input int      MagicNumber       = 20260101;
input int      HeartbeatInterval = 1; // seconds
input double   FixedLotSize      = 0.01;
input int      StopLoss_Points   = 300;
input int      TakeProfit_Points = 600;
input bool     UseMonetaryTrail  = true;
input double   TrailTrigger1     = 1.00; // Level 1: $1.00 Profit
input double   TrailLock1        = 0.20; // Lock $0.20
input double   TrailTrigger2     = 2.00; // Level 2: $2.00 Profit
input double   TrailLock2        = 0.40; // Lock $0.40
input double   TrailTrigger3     = 3.00; // Level 3: $3.00 Profit
input double   TrailLock3        = 0.60; // Lock $0.60
input bool     DrawFVG           = true;
input bool     DrawOB            = true;
input color    BullFVGColor      = clrLightBlue;
input color    BearFVGColor      = clrLightPink;
input color    BullOBColor       = clrBlue;
input color    BearOBColor       = clrRed;

//+------------------------------------------------------------------+
//| GLOBAL VARIABLES                                                 |
//+------------------------------------------------------------------+
CTrade            trade;
CPositionInfo     posInfo;
bool              licenseValid      = false;
bool              isPaused          = false;
datetime          lastHeartbeat     = 0;
string            EA_Name           = "FxScalpKing EA v2.15";

// Indicators
int handle_ema20, handle_ema50, handle_atr;

//+------------------------------------------------------------------+
//| EXPERT INITIALIZATION                                            |
//+------------------------------------------------------------------+
int OnInit()
{
   Print("=== ", EA_Name, " Starting ===");
   
   FxScalpKing.SetServerUrl(ServerURL);
   FxScalpKing.SetApiKey(ApiKey);

   string expiry, plan;
   if(!FxScalpKing.ValidateLicense(expiry, plan))
   {
      Print("❌ License validation failed. Check API key or Server URL.");
      return INIT_FAILED;
   }
   
   licenseValid = true;
   trade.SetExpertMagicNumber(MagicNumber);
   
   handle_ema20 = iMA(_Symbol, PERIOD_M5, 20, 0, MODE_EMA, PRICE_CLOSE);
   handle_ema50 = iMA(_Symbol, PERIOD_M5, 50, 0, MODE_EMA, PRICE_CLOSE);
   handle_atr   = iATR(_Symbol, PERIOD_M5, 14);

   EventSetTimer(1);
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
}

void OnTimer()
{
   if(!licenseValid) return;
   
   if(TimeCurrent() - lastHeartbeat >= HeartbeatInterval)
   {
      SendHeartbeat();
      PollCommands();
      lastHeartbeat = TimeCurrent();
   }
}

void OnTick()
{
   if(!licenseValid) return;
   
   // --- Draw Zones ---
   if(DrawFVG) ManageFVGs();
   if(DrawOB)  ManageOBs();
   
   // --- Monetary Trailing Stop ($1 -> $0.20, $2 -> $0.40) ---
   if(UseMonetaryTrail)
   {
      for(int i=PositionsTotal()-1; i>=0; i--)
      {
         if(posInfo.SelectByIndex(i) && posInfo.Symbol() == _Symbol && posInfo.Magic() == MagicNumber)
         {
            double profit = posInfo.Profit();
            double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
            double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
            double point = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
            
            double targetLock = 0;
            if(profit >= TrailTrigger3) targetLock = TrailLock3;
            else if(profit >= TrailTrigger2) targetLock = TrailLock2;
            else if(profit >= TrailTrigger1) targetLock = TrailLock1;
            
            if(targetLock > 0)
            {
               double lockPoints = targetLock / (FixedLotSize * (SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE) / SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE)));
               
               if(posInfo.PositionType() == POSITION_TYPE_BUY)
               {
                  double newSL = posInfo.PriceOpen() + lockPoints * point;
                  if(posInfo.StopLoss() < newSL - 5 * point) // Small buffer
                  {
                     trade.PositionModify(posInfo.Ticket(), newSL, posInfo.TakeProfit());
                  }
               }
               else if(posInfo.PositionType() == POSITION_TYPE_SELL)
               {
                  double newSL = posInfo.PriceOpen() - lockPoints * point;
                  if(posInfo.StopLoss() > newSL + 5 * point || posInfo.StopLoss() == 0)
                  {
                     trade.PositionModify(posInfo.Ticket(), newSL, posInfo.TakeProfit());
                  }
               }
            }
         }
      }
   }
}

//+------------------------------------------------------------------+
//| HEARTBEAT LOGIC                                                 |
//+------------------------------------------------------------------+
void SendHeartbeat()
{
   MqlTick tick;
   if(!SymbolInfoTick(_Symbol, tick)) return;

   double ema20[1], ema50[1], atr[1];
   CopyBuffer(handle_ema20, 0, 0, 1, ema20);
   CopyBuffer(handle_ema50, 0, 0, 1, ema50);
   CopyBuffer(handle_atr, 0, 0, 1, atr);

   string json = "{";
   json += "\"apiKey\":\"" + ApiKey + "\",";
   json += "\"symbol\":\"" + _Symbol + "\",";
   json += "\"price\":" + DoubleToString(tick.bid, _Digits) + ",";
   json += "\"spread\":" + DoubleToString((tick.ask - tick.bid)/_Point, 0) + ",";
   json += "\"balance\":" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) + ",";
   json += "\"equity\":" + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2) + ",";
   // Additive fields for backend margin checks (see risk-manager). Backend field
   // names expected: "freeMargin" and "marginLevel" (percent, e.g. 250 = 250%).
   json += "\"freeMargin\":" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_FREE), 2) + ",";
   json += "\"marginLevel\":" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_LEVEL), 2) + ",";
   json += "\"ema20\":" + DoubleToString(ema20[0], _Digits) + ",";
   json += "\"ema50\":" + DoubleToString(ema50[0], _Digits) + ",";
   json += "\"atr14\":" + DoubleToString(atr[0], _Digits) + ",";
   json += "\"isPaused\":" + (isPaused ? "true" : "false") + ",";
   
   // Multi-Timeframe Chart Data
   json += "\"chart\":{";
   
   // M5
   json += "\"M5\":[";
   MqlRates ratesM5[];
   ArraySetAsSeries(ratesM5, true);
   if(CopyRates(_Symbol, PERIOD_M5, 0, 100, ratesM5) > 0) {
      for(int i=0; i<100; i++) {
         json += "{\"x\":" + IntegerToString(100 - i) + ",\"open\":" + DoubleToString(ratesM5[i].open, _Digits) + ",\"high\":" + DoubleToString(ratesM5[i].high, _Digits) + ",\"low\":" + DoubleToString(ratesM5[i].low, _Digits) + ",\"close\":" + DoubleToString(ratesM5[i].close, _Digits) + ",\"timestamp\":" + IntegerToString(ratesM5[i].time) + "}";
         if(i < 99) json += ",";
      }
   }
   json += "],";

   // M15
   json += "\"M15\":[";
   MqlRates ratesM15[];
   ArraySetAsSeries(ratesM15, true);
   if(CopyRates(_Symbol, PERIOD_M15, 0, 100, ratesM15) > 0) {
      for(int i=0; i<100; i++) {
         json += "{\"x\":" + IntegerToString(100 - i) + ",\"open\":" + DoubleToString(ratesM15[i].open, _Digits) + ",\"high\":" + DoubleToString(ratesM15[i].high, _Digits) + ",\"low\":" + DoubleToString(ratesM15[i].low, _Digits) + ",\"close\":" + DoubleToString(ratesM15[i].close, _Digits) + ",\"timestamp\":" + IntegerToString(ratesM15[i].time) + "}";
         if(i < 99) json += ",";
      }
   }
   json += "],";

   // H1
   json += "\"H1\":[";
   MqlRates ratesH1[];
   ArraySetAsSeries(ratesH1, true);
   if(CopyRates(_Symbol, PERIOD_H1, 0, 100, ratesH1) > 0) {
      for(int i=0; i<100; i++) {
         json += "{\"x\":" + IntegerToString(100 - i) + ",\"open\":" + DoubleToString(ratesH1[i].open, _Digits) + ",\"high\":" + DoubleToString(ratesH1[i].high, _Digits) + ",\"low\":" + DoubleToString(ratesH1[i].low, _Digits) + ",\"close\":" + DoubleToString(ratesH1[i].close, _Digits) + ",\"timestamp\":" + IntegerToString(ratesH1[i].time) + "}";
         if(i < 99) json += ",";
      }
   }
   json += "]";
   
   json += "},";
   
   // Positions
   json += "\"openPositions\":[";
   bool first = true;
   for(int i=PositionsTotal()-1; i>=0; i--)
   {
      if(posInfo.SelectByIndex(i) && posInfo.Symbol() == _Symbol && posInfo.Magic() == MagicNumber)
      {
         if(!first) json += ",";
         json += "{\"ticket\":" + IntegerToString(posInfo.Ticket()) + ",";
         json += "\"type\":\"" + (posInfo.PositionType()==POSITION_TYPE_BUY?"BUY":"SELL") + "\",";
         json += "\"lots\":" + DoubleToString(posInfo.Volume(), 2) + ",";
         json += "\"price\":" + DoubleToString(posInfo.PriceOpen(), _Digits) + ",";
         json += "\"profit\":" + DoubleToString(posInfo.Profit(), 2) + ",";
         json += "\"sl\":" + DoubleToString(posInfo.StopLoss(), _Digits) + ",";
         json += "\"tp\":" + DoubleToString(posInfo.TakeProfit(), _Digits) + "}";
         first = false;
      }
   }
   json += "],";
   
   // Closed Trades (History)
   json += "\"closedTrades\":[";
   if(HistorySelect(TimeCurrent()-86400, TimeCurrent()))
   {
      int totalHistory = HistoryDealsTotal();
      int count = 0;
      for(int i=totalHistory-1; i>=0 && count < 20; i--)
      {
         ulong ticket = HistoryDealGetTicket(i);
         if(HistoryDealGetString(ticket, DEAL_SYMBOL) == _Symbol && HistoryDealGetInteger(ticket, DEAL_MAGIC) == MagicNumber)
         {
            long entryType = HistoryDealGetInteger(ticket, DEAL_ENTRY);
            if(entryType == DEAL_ENTRY_OUT)
            {
               ulong orderTicket = HistoryDealGetInteger(ticket, DEAL_ORDER);
               if(HistoryOrderSelect(orderTicket))
               {
                  if(count > 0) json += ",";
                  json += "{\"ticket\":" + IntegerToString(orderTicket) + ",";
                  json += "\"symbol\":\"" + _Symbol + "\",";
                  json += "\"type\":\"" + (HistoryOrderGetInteger(orderTicket, ORDER_TYPE) == ORDER_TYPE_BUY ? "BUY" : "SELL") + "\",";
                  json += "\"lots\":" + DoubleToString(HistoryOrderGetDouble(orderTicket, ORDER_VOLUME_INITIAL), 2) + ",";
                  json += "\"openPrice\":" + DoubleToString(HistoryOrderGetDouble(orderTicket, ORDER_PRICE_OPEN), _Digits) + ",";
                  json += "\"closePrice\":" + DoubleToString(HistoryDealGetDouble(ticket, DEAL_PRICE), _Digits) + ",";
                  json += "\"profit\":" + DoubleToString(HistoryDealGetDouble(ticket, DEAL_PROFIT), 2) + ",";
                  json += "\"sl\":" + DoubleToString(HistoryOrderGetDouble(orderTicket, ORDER_SL), _Digits) + ",";
                  json += "\"tp\":" + DoubleToString(HistoryOrderGetDouble(orderTicket, ORDER_TP), _Digits) + ",";
                  json += "\"openTime\":" + IntegerToString(HistoryOrderGetInteger(orderTicket, ORDER_TIME_SETUP)) + ",";
                  json += "\"closeTime\":" + IntegerToString(HistoryDealGetInteger(ticket, DEAL_TIME)) + "}";
                  count++;
               }
            }
         }
      }
   }
   json += "],";
   
   // Send M5 candles
   json += "\"candles\":[";
   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   int lookback = 100; 
   if(CopyRates(_Symbol, PERIOD_M5, 0, lookback, rates) > 0)
   {
      for(int i=0; i<lookback; i++)
      {
         json += "{\"x\":" + IntegerToString(lookback - i) + ",";
         json += "\"open\":" + DoubleToString(rates[i].open, _Digits) + ",";
         json += "\"high\":" + DoubleToString(rates[i].high, _Digits) + ",";
         json += "\"low\":" + DoubleToString(rates[i].low, _Digits) + ",";
         json += "\"close\":" + DoubleToString(rates[i].close, _Digits) + ",";
         json += "\"timestamp\":" + IntegerToString(rates[i].time) + "}";
         if(i < lookback - 1) json += ",";
      }
   }
   json += "]}";

   string resp;
   FxScalpKing.SendHeartbeat(json, resp);
}

//+------------------------------------------------------------------+
//| MINIMAL MANUAL JSON HELPERS                                      |
//| No JSON library is used elsewhere in this project, so command    |
//| payloads are parsed field-by-field rather than via fragile        |
//| whole-response substring search.                                 |
//+------------------------------------------------------------------+
int SplitJsonArray(string json, string &out[])
{
   int start = StringFind(json, "[");
   int stop  = StringFind(json, "]", start);
   if(start < 0 || stop < 0) return 0;

   string inner = StringSubstr(json, start + 1, stop - start - 1);
   int depth = 0;
   int objStart = -1;
   int n = 0;
   ArrayResize(out, 0);

   for(int i = 0; i < StringLen(inner); i++)
   {
      ushort ch = StringGetCharacter(inner, i);
      if(ch == '{')
      {
         if(depth == 0) objStart = i;
         depth++;
      }
      else if(ch == '}')
      {
         depth--;
         if(depth == 0 && objStart >= 0)
         {
            n++;
            ArrayResize(out, n);
            out[n - 1] = StringSubstr(inner, objStart, i - objStart + 1);
            objStart = -1;
         }
      }
   }
   return n;
}

string GetJsonStringField(string obj, string key)
{
   string pattern = "\"" + key + "\":\"";
   int idx = StringFind(obj, pattern);
   if(idx < 0) return "";
   int valStart = idx + StringLen(pattern);
   int valEnd = StringFind(obj, "\"", valStart);
   if(valEnd < 0) return "";
   return StringSubstr(obj, valStart, valEnd - valStart);
}

double GetJsonNumberField(string obj, string key, double defaultVal)
{
   string pattern = "\"" + key + "\":";
   int idx = StringFind(obj, pattern);
   if(idx < 0) return defaultVal;
   int valStart = idx + StringLen(pattern);
   int valEnd = valStart;
   int len = StringLen(obj);
   while(valEnd < len)
   {
      ushort ch = StringGetCharacter(obj, valEnd);
      bool isNumChar = (ch >= '0' && ch <= '9') || ch == '-' || ch == '+' || ch == '.' || ch == 'e' || ch == 'E';
      if(!isNumChar) break;
      valEnd++;
   }
   if(valEnd == valStart) return defaultVal;
   return StringToDouble(StringSubstr(obj, valStart, valEnd - valStart));
}

void PollCommands()
{
   string resp = FxScalpKing.GetCommands();
   if(resp == "" || resp == "[]") return;

   string cmds[];
   int count = SplitJsonArray(resp, cmds);

   for(int i = 0; i < count; i++)
   {
      string obj = cmds[i];
      string action = GetJsonStringField(obj, "action");
      if(action == "") action = GetJsonStringField(obj, "type");

      if(action == "BUY")
      {
         double lots = GetJsonNumberField(obj, "lots", 0);
         double sl   = GetJsonNumberField(obj, "sl", 0);
         double tp   = GetJsonNumberField(obj, "tp", 0);
         OpenBuy(lots, sl, tp);
      }
      else if(action == "SELL")
      {
         double lots = GetJsonNumberField(obj, "lots", 0);
         double sl   = GetJsonNumberField(obj, "sl", 0);
         double tp   = GetJsonNumberField(obj, "tp", 0);
         OpenSell(lots, sl, tp);
      }
      else if(action == "PAUSE")
      {
         isPaused = true;
         Print("⏸ EA Paused");
      }
      else if(action == "RESUME")
      {
         isPaused = false;
         Print("▶ EA Resumed");
      }
      else if(action == "CLOSE_ALL")
      {
         CloseAllTrades();
      }
      else if(action == "UPDATE_SL")
      {
         ulong ticket = (ulong)GetJsonNumberField(obj, "ticket", 0);
         double newSl = GetJsonNumberField(obj, "sl", 0);
         if(ticket > 0 && newSl > 0) UpdateStopLoss(ticket, newSl);
         else Print("❌ UPDATE_SL command missing valid ticket/sl: ", obj);
      }
   }
}

// cmdLots/cmdSl/cmdTp: values sent by the backend in the trade command.
// When present and non-zero they take priority over the static EA inputs.
void OpenBuy(double cmdLots = 0, double cmdSl = 0, double cmdTp = 0)
{
   if(isPaused) return;

   double lot = (cmdLots > 0) ? cmdLots : FixedLotSize;

   const int maxAttempts = 3; // 1 initial try + 2 retries
   for(int attempt = 1; attempt <= maxAttempts; attempt++)
   {
      double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
      double sl = (cmdSl > 0) ? cmdSl : ask - StopLoss_Points * _Point;
      double tp = (cmdTp > 0) ? cmdTp : ask + TakeProfit_Points * _Point;

      ResetLastError();
      if(trade.Buy(lot, _Symbol, ask, sl, tp, "App Brain Buy"))
      {
         Print("✅ Buy Order Placed: ", lot, " SL=", sl, " TP=", tp);
         return;
      }

      Print("❌ Buy Order Failed (attempt ", attempt, "/", maxAttempts, "): broker error ", GetLastError());
      if(attempt < maxAttempts) Sleep(300);
   }
}

void OpenSell(double cmdLots = 0, double cmdSl = 0, double cmdTp = 0)
{
   if(isPaused) return;

   double lot = (cmdLots > 0) ? cmdLots : FixedLotSize;

   const int maxAttempts = 3; // 1 initial try + 2 retries
   for(int attempt = 1; attempt <= maxAttempts; attempt++)
   {
      double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      double sl = (cmdSl > 0) ? cmdSl : bid + StopLoss_Points * _Point;
      double tp = (cmdTp > 0) ? cmdTp : bid - TakeProfit_Points * _Point;

      ResetLastError();
      if(trade.Sell(lot, _Symbol, bid, sl, tp, "App Brain Sell"))
      {
         Print("✅ Sell Order Placed: ", lot, " SL=", sl, " TP=", tp);
         return;
      }

      Print("❌ Sell Order Failed (attempt ", attempt, "/", maxAttempts, "): broker error ", GetLastError());
      if(attempt < maxAttempts) Sleep(300);
   }
}

// Applies a trailing-stop update sent by the backend as an UPDATE_SL command.
void UpdateStopLoss(ulong ticket, double newSl)
{
   if(!PositionSelectByTicket(ticket))
   {
      Print("❌ UPDATE_SL failed: position ticket ", ticket, " not found");
      return;
   }
   double tp = PositionGetDouble(POSITION_TP);

   const int maxAttempts = 3; // 1 initial try + 2 retries
   for(int attempt = 1; attempt <= maxAttempts; attempt++)
   {
      ResetLastError();
      if(trade.PositionModify(ticket, newSl, tp))
      {
         Print("✅ UPDATE_SL applied: ticket=", ticket, " newSL=", newSl);
         return;
      }

      Print("❌ UPDATE_SL failed (attempt ", attempt, "/", maxAttempts, "): ticket=", ticket, " broker error ", GetLastError());
      if(attempt < maxAttempts) Sleep(300);
   }
}

void CloseAllTrades()
{
   for(int i=PositionsTotal()-1; i>=0; i--)
   {
      if(posInfo.SelectByIndex(i) && posInfo.Symbol() == _Symbol && posInfo.Magic() == MagicNumber)
      {
         trade.PositionClose(posInfo.Ticket());
      }
   }
   Print("✅ All Trades Closed");
}

//+------------------------------------------------------------------+
//| FVG MANAGEMENT & DRAWING                                         |
//+------------------------------------------------------------------+
void ManageFVGs()
{
   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   if(CopyRates(_Symbol, PERIOD_M5, 0, 50, rates) < 10) return;

   for(int i=1; i < 48; i++)
   {
      // Bullish FVG: Low of candle 1 > High of candle 3
      if(rates[i].low > rates[i+2].high + 2 * _Point)
      {
         string name = "FVG_Bull_" + IntegerToString(rates[i+1].time);
         if(ObjectFind(0, name) < 0)
         {
            ObjectCreate(0, name, OBJ_RECTANGLE, 0, rates[i+1].time, rates[i+2].high, rates[i].time, rates[i].low);
            ObjectSetInteger(0, name, OBJPROP_COLOR, BullFVGColor);
            ObjectSetInteger(0, name, OBJPROP_FILL, true);
            ObjectSetInteger(0, name, OBJPROP_BACK, true);
         }
      }
      // Bearish FVG: High of candle 1 < Low of candle 3
      else if(rates[i].high < rates[i+2].low - 2 * _Point)
      {
         string name = "FVG_Bear_" + IntegerToString(rates[i+1].time);
         if(ObjectFind(0, name) < 0)
         {
            ObjectCreate(0, name, OBJ_RECTANGLE, 0, rates[i+1].time, rates[i+2].low, rates[i].time, rates[i].high);
            ObjectSetInteger(0, name, OBJPROP_COLOR, BearFVGColor);
            ObjectSetInteger(0, name, OBJPROP_FILL, true);
            ObjectSetInteger(0, name, OBJPROP_BACK, true);
         }
      }
   }
}

//+------------------------------------------------------------------+
//| OB MANAGEMENT & DRAWING                                          |
//+------------------------------------------------------------------+
void ManageOBs()
{
   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   if(CopyRates(_Symbol, PERIOD_M5, 0, 50, rates) < 10) return;

   for(int i=1; i < 48; i++)
   {
      // Bullish OB: Bearish candle before a strong Bullish move (break of high)
      if(rates[i+1].close < rates[i+1].open && rates[i].close > rates[i+1].high)
      {
         string name = "OB_Bull_" + IntegerToString(rates[i+1].time);
         if(ObjectFind(0, name) < 0)
         {
            ObjectCreate(0, name, OBJ_RECTANGLE, 0, rates[i+1].time, rates[i+1].low, rates[i].time, rates[i+1].high);
            ObjectSetInteger(0, name, OBJPROP_COLOR, BullOBColor);
            ObjectSetInteger(0, name, OBJPROP_FILL, true);
            ObjectSetInteger(0, name, OBJPROP_BACK, true);
         }
      }
      // Bearish OB: Bullish candle before a strong Bearish move (break of low)
      else if(rates[i+1].close > rates[i+1].open && rates[i].close < rates[i+1].low)
      {
         string name = "OB_Bear_" + IntegerToString(rates[i+1].time);
         if(ObjectFind(0, name) < 0)
         {
            ObjectCreate(0, name, OBJ_RECTANGLE, 0, rates[i+1].time, rates[i+1].high, rates[i].time, rates[i+1].low);
            ObjectSetInteger(0, name, OBJPROP_COLOR, BearOBColor);
            ObjectSetInteger(0, name, OBJPROP_FILL, true);
            ObjectSetInteger(0, name, OBJPROP_BACK, true);
         }
      }
   }
}

double CalculateLotSize()
{
   double equity = AccountInfoDouble(ACCOUNT_EQUITY);
   double lot = MathMax(0.01, MathFloor(equity / 1000.0) * 0.05); // 0.05 lot per $1000
   return MathMin(lot, 10.0);
}
