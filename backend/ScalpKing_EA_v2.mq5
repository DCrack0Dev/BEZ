//+------------------------------------------------------------------+
//|                                              ScalpKing_EA_v2.mq5 |
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
//| INPUT PARAMETERS                                                 |
//+------------------------------------------------------------------+
input string   ApiKey            = "FXSK-90e36448c3d1ef9d749aa155ba228541";
input string   ServerURL         = "https://liquibot-back.onrender.com";
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
input bool     UseTrailingStop   = true;
input int      HeartbeatInterval  = 3;
input bool     DeleteMitigated   = true;
input int      MaxZonesTotal     = 30;
input color    BullColor         = clrLimeGreen;
input color    BearColor         = clrTomato;

//+------------------------------------------------------------------+
//| GLOBAL VARIABLES                                                 |
//+------------------------------------------------------------------+
CTrade            trade;
CPositionInfo     posInfo;

int            handle_FastEMA_M5, handle_SlowEMA_M5;
int            handle_FastEMA_M1, handle_SlowEMA_M1;
int            handle_BB_M5;
int            handle_RSI7_M5;
int            handle_ATR_M5;

double         fastEMA_M5[], slowEMA_M5[];
double         fastEMA_M1[], slowEMA_M1[];
double         bb_upper[], bb_lower[], bb_middle[];
double         rsi7_M5[];

bool           licenseValid      = false;
datetime       lastHeartbeat    = 0;
string         EA_Name           = "FxScalpKing EA v2.0";
string         licenseExpiry     = "";
string         licensePlan       = "";

//+------------------------------------------------------------------+
//| FUNCTION PROTOTYPES                                              |
//+------------------------------------------------------------------+
void PerformSMCAnalysis();
void SendHeartbeat();
bool GetIndicatorData();
bool IsWithinSession();
bool ValidateLicense();
void ProcessCommand(string cmd);
void OpenBuy(double sl = 0, double tp = 0);
void OpenSell(double sl = 0, double tp = 0);
void DrawZone(string name, datetime t1, double p1, datetime t2, double p2, color clr);
void DrawKeyLevel(string name, double price, color clr, string txt);

//+------------------------------------------------------------------+
//| EXPERT INITIALIZATION                                            |
//+------------------------------------------------------------------+
int OnInit()
{
   Print("=== ", EA_Name, " Starting ===");
   
   FxScalpKing.SetServerUrl(ServerURL);
   FxScalpKing.SetApiKey(ApiKey);

   if(!ValidateLicense())
   {
      Alert("❌ Invalid or expired API Key.");
      return INIT_FAILED;
   }
   licenseValid = true;
   Print("✅ License validated. Plan: ", licensePlan, " | Expires: ", licenseExpiry);

   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetDeviationInPoints(10);

   // Do not modify chart style/layout to avoid chart shifting.

   // Initialize Indicators
   handle_FastEMA_M5 = iMA(_Symbol, PERIOD_M5, FastEMA_Period, 0, MODE_EMA, PRICE_CLOSE);
   handle_SlowEMA_M5 = iMA(_Symbol, PERIOD_M5, SlowEMA_Period, 0, MODE_EMA, PRICE_CLOSE);
   handle_BB_M5      = iBands(_Symbol, PERIOD_M5, BB_Period, 0, BB_Deviation, PRICE_CLOSE);
   handle_RSI7_M5    = iRSI(_Symbol, PERIOD_M5, 7, PRICE_CLOSE);
   handle_ATR_M5     = iATR(_Symbol, PERIOD_M5, 14);
   handle_FastEMA_M1 = iMA(_Symbol, PERIOD_M1, FastEMA_Period, 0, MODE_EMA, PRICE_CLOSE);
   handle_SlowEMA_M1 = iMA(_Symbol, PERIOD_M1, SlowEMA_Period, 0, MODE_EMA, PRICE_CLOSE);

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
   IndicatorRelease(handle_FastEMA_M1);
   IndicatorRelease(handle_SlowEMA_M1);
   IndicatorRelease(handle_RSI7_M5);
   IndicatorRelease(handle_ATR_M5);
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
   
   SendHeartbeat();
}

//+------------------------------------------------------------------+
//| PERFORM LOCAL SMC ANALYSIS & DRAWING                             |
//+------------------------------------------------------------------+
void PerformSMCAnalysis()
{
   // 1. Mitigation Check: Disabled for debugging
   /*
   if(DeleteMitigated)
   {
      double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      for(int i = ObjectsTotal(0, 0, OBJ_RECTANGLE) - 1; i >= 0; i--)
      {
         string name = ObjectName(0, i, 0, OBJ_RECTANGLE);
         if(StringFind(name, "SMC_") < 0) continue;
         double top = ObjectGetDouble(0, name, OBJPROP_PRICE, 0);
         double bottom = ObjectGetDouble(0, name, OBJPROP_PRICE, 1);
         if(bid <= top && bid >= bottom) ObjectDelete(0, name);
      }
   }
   */

   // 2. Freshness Check: Only redraw every 60s (BUT update backend every tick)
   static datetime lastCleanup = 0;
   bool shouldRedraw = (TimeCurrent() - lastCleanup >= 60);
   if(shouldRedraw) lastCleanup = TimeCurrent();

   int currentZones = 0;
   static string lastFinalJson = "{\"orderBlocks\":[],\"keyLevels\":[],\"fvgs\":[],\"marketStructure\":[]}";
   
   if(shouldRedraw)
   {
      string obJson = "["; string klJson = "[";
      bool firstOB = true; bool firstKL = true;
      Print("🔍 Brain: Refreshing SMC Zones...");

      ENUM_TIMEFRAMES tfs[] = {PERIOD_H4, PERIOD_H1, PERIOD_M15};
      
      for(int t = 0; t < ArraySize(tfs); t++)
      {
         ENUM_TIMEFRAMES tf = tfs[t];
         double high[], low[], close[], open[];
         long volume[];
         ArraySetAsSeries(high, true); ArraySetAsSeries(low, true);
         ArraySetAsSeries(close, true); ArraySetAsSeries(open, true);
         ArraySetAsSeries(volume, true);
         
         if(CopyHigh(_Symbol, tf, 0, 100, high) < 50) continue;
         CopyLow(_Symbol, tf, 0, 100, low);
         CopyClose(_Symbol, tf, 0, 100, close);
         CopyOpen(_Symbol, tf, 0, 100, open);
         CopyTickVolume(_Symbol, tf, 0, 100, volume);
         
         string tfStr = (tf == PERIOD_H4) ? "H4" : ((tf == PERIOD_H1) ? "H1" : "M15");

         // 1. Key Levels (Relaxed Window)
         int swingWindow = (tf == PERIOD_H4) ? 12 : ((tf == PERIOD_H1) ? 8 : 5);
         for(int i = swingWindow; i < 90 && currentZones < MaxZonesTotal; i++)
         {
            bool isHigh = true, isLow = true;
            for(int j = 1; j <= swingWindow; j++) {
               if(high[i] <= high[i-j] || high[i] <= high[i+j]) isHigh = false;
               if(low[i] >= low[i-j] || low[i] >= low[i+j]) isLow = false;
            }

            if(isHigh || isLow)
            {
               double price = isHigh ? high[i] : low[i];
               string type = isHigh ? "RESISTANCE" : "SUPPORT";
               string name = "SMC_KL_" + tfStr + "_" + IntegerToString((int)iTime(_Symbol, tf, i));
               
               DrawKeyLevel(name, price, isHigh ? BearColor : BullColor, tfStr + (isHigh ? " Res" : " Sup"));
               currentZones++;

               if(!firstKL) klJson += ",";
               klJson += "{\"type\":\"" + type + "\",\"price\":" + DoubleToString(price, 5) + ",\"tf\":\"" + tfStr + "\",\"label\":\"" + tfStr + " Key Level\"}";
               firstKL = false;
            }
         }

         // 2. Order Blocks (Relaxed Displacement)
         int tfOBs = 0;
         for(int i = 1; i < 80 && currentZones < MaxZonesTotal && tfOBs < 4; i++)
         {
            double body = MathAbs(close[i] - open[i]);
            double range = high[i] - low[i];
            if(range <= 0) range = _Point;

            // Relaxed to 60% displacement
            if(body > range * 0.6 && volume[i] > volume[i+1])
            {
               bool isBull = close[i] > open[i];
               double top = high[i+1]; double bottom = low[i+1];
               
               string name = "SMC_OB_" + tfStr + "_" + (isBull ? "BULL_" : "BEAR_") + IntegerToString((int)iTime(_Symbol, tf, i+1));
               DrawZone(name, iTime(_Symbol, tf, i+1), top, TimeCurrent() + 14400, bottom, isBull ? BullColor : BearColor);
               currentZones++; tfOBs++;
               
               if(!firstOB) obJson += ",";
               obJson += "{\"type\":\"" + (string)(isBull ? "BULLISH" : "BEARISH") + "\",\"top\":" + DoubleToString(top, 5) + ",\"bottom\":" + DoubleToString(bottom, 5) + ",\"tf\":\"" + tfStr + "\",\"label\":\"" + tfStr + " OB\"}";
               firstOB = false;
            }
         }
      }
      klJson += "]"; obJson += "]";
      lastFinalJson = "{\"orderBlocks\":" + obJson + ",\"keyLevels\":" + klJson + ",\"fvgs\":[],\"marketStructure\":[]}";
      Print("✅ Brain: Found ", currentZones, " SMC Zones.");
   }
   
   FxScalpKing.SetStructures(lastFinalJson); 
}

//+------------------------------------------------------------------+
//| GET INDICATOR DATA                                               |
//+------------------------------------------------------------------+
bool GetIndicatorData()
{
   ArraySetAsSeries(fastEMA_M5, true); ArraySetAsSeries(slowEMA_M5, true);
   ArraySetAsSeries(fastEMA_M1, true); ArraySetAsSeries(slowEMA_M1, true);
   ArraySetAsSeries(bb_upper, true); ArraySetAsSeries(bb_lower, true); ArraySetAsSeries(bb_middle, true);
   ArraySetAsSeries(rsi7_M5, true);

   if(CopyBuffer(handle_FastEMA_M5, 0, 0, 3, fastEMA_M5) < 3) return false;
   if(CopyBuffer(handle_SlowEMA_M5, 0, 0, 3, slowEMA_M5) < 3) return false;
   if(CopyBuffer(handle_BB_M5, 0, 0, 3, bb_middle) < 3) return false;
   if(CopyBuffer(handle_BB_M5, 1, 0, 3, bb_upper) < 3) return false;
   if(CopyBuffer(handle_BB_M5, 2, 0, 3, bb_lower) < 3) return false;
   if(CopyBuffer(handle_RSI7_M5, 0, 0, 3, rsi7_M5) < 3) return false;
   if(CopyBuffer(handle_FastEMA_M1, 0, 0, 3, fastEMA_M1) < 3) return false;
   if(CopyBuffer(handle_SlowEMA_M1, 0, 0, 3, slowEMA_M1) < 3) return false;

   return true;
}

//+------------------------------------------------------------------+
//| OPEN BUY TRADE                                                   |
//+------------------------------------------------------------------+
void OpenBuy(double sl = 0, double tp = 0)
{
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double point = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   double finalSl = (sl > 0) ? sl : (ask - StopLoss_Points * point);
   double finalTp = (tp > 0) ? tp : (ask + TakeProfit_Points * point);

   if(trade.Buy(LotSize, _Symbol, ask, finalSl, finalTp, EA_Name))
      FxScalpKing.NotifyTradeExecuted(trade.ResultOrder(), "BUY", LotSize, ask, finalSl, finalTp, AccountInfoDouble(ACCOUNT_PROFIT));
}

//+------------------------------------------------------------------+
//| OPEN SELL TRADE                                                  |
//+------------------------------------------------------------------+
void OpenSell(double sl = 0, double tp = 0)
{
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double point = SymbolInfoDouble(_Symbol, SYMBOL_POINT);
   double finalSl = (sl > 0) ? sl : (bid + StopLoss_Points * point);
   double finalTp = (tp > 0) ? tp : (bid - TakeProfit_Points * point);

   if(trade.Sell(LotSize, _Symbol, bid, finalSl, finalTp, EA_Name))
      FxScalpKing.NotifyTradeExecuted(trade.ResultOrder(), "SELL", LotSize, bid, finalSl, finalTp, AccountInfoDouble(ACCOUNT_PROFIT));
}

bool CloseTrade(ulong ticket) { return trade.PositionClose(ticket); }

void CloseAllTrades()
{
   for(int i = PositionsTotal()-1; i >= 0; i--)
      if(posInfo.SelectByIndex(i) && posInfo.Magic() == MagicNumber) trade.PositionClose(posInfo.Ticket());
}

bool IsWithinSession()
{
   MqlDateTime dt; TimeToStruct(TimeCurrent(), dt);
   return (dt.hour >= SessionStartHour && dt.hour < SessionEndHour);
}

bool ValidateLicense() { return FxScalpKing.ValidateLicense(licenseExpiry, licensePlan); }

void SendHeartbeat()
{
   datetime now = TimeCurrent();
   if(now - lastHeartbeat < HeartbeatInterval) return;

   if(GetIndicatorData()) {
      double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      FxScalpKing.SetMarketData(bid, fastEMA_M5[0], slowEMA_M5[0], bb_upper[0], bb_lower[0]);
   }

   string commands[];
   if(FxScalpKing.SendHeartbeat(commands))
   {
      lastHeartbeat = now;
      for(int i = 0; i < ArraySize(commands); i++) ProcessCommand(commands[i]);
   }
}

void ProcessCommand(string cmd)
{
   string parts[];
   int numParts = StringSplit(cmd, '|', parts);
   if(numParts == 0) return;
   
   string action = parts[0];
   if(action == "BUY" && numParts >= 3) OpenBuy(StringToDouble(parts[1]), StringToDouble(parts[2]));
   else if(action == "SELL" && numParts >= 3) OpenSell(StringToDouble(parts[1]), StringToDouble(parts[2]));
   else if(action == "CLOSE_ALL") CloseAllTrades();
   else if(action == "SET_TF" && numParts >= 2) FxScalpKing.SetRequestedTf(parts[1]);
   else if(StringFind(action, "CLOSE_TICKET_") == 0) CloseTrade((ulong)StringToInteger(StringSubstr(action, 13)));
   else if((action == "DRAW_OB" || action == "DRAW_FVG" || action == "DRAW_KEY_LEVEL" || action == "DRAW_KL") && numParts >= 5) {
      double top = StringToDouble(parts[1]);
      double bottom = StringToDouble(parts[2]);
      string zoneType = parts[3];
      datetime zTime = (datetime)StringToInteger(parts[4]);

      bool isBull = (zoneType == "BULLISH" || zoneType == "BULL");
      if(action == "DRAW_KEY_LEVEL" || action == "DRAW_KL")
      {
         double lvl = (top > 0.0 ? top : bottom);
         if(lvl <= 0.0) return;
         DrawKeyLevel("SMC_KL_" + IntegerToString((int)zTime), lvl, isBull ? BullColor : BearColor, "KL");
      }
      else
      {
         color clr = isBull ? BullColor : BearColor;
         if(action == "DRAW_FVG") clr = isBull ? clrBlue : clrRed;
         DrawZone("SMC_" + action + "_" + parts[4], zTime, top, TimeCurrent() + 3600, bottom, clr);
      }
   }
}

void DrawZone(string name, datetime t1, double p1, datetime t2, double p2, color clr)
{
   ObjectDelete(0, name);
   ObjectCreate(0, name, OBJ_RECTANGLE, 0, t1, MathMax(p1, p2), t2, MathMin(p1, p2));
   ObjectSetInteger(0, name, OBJPROP_COLOR, clr);
   ObjectSetInteger(0, name, OBJPROP_FILL, true);
   ObjectSetInteger(0, name, OBJPROP_BACK, true);
}

void DrawKeyLevel(string name, double price, color clr, string txt)
{
   ObjectDelete(0, name);
   ObjectCreate(0, name, OBJ_HLINE, 0, 0, price);
   ObjectSetInteger(0, name, OBJPROP_COLOR, clr);
   ObjectSetInteger(0, name, OBJPROP_STYLE, STYLE_DOT);
   ObjectSetString(0, name, OBJPROP_TEXT, txt);
}
