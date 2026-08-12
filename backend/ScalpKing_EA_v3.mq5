//+------------------------------------------------------------------+
//|                                              ScalpKing_EA_v3.mq5 |
//|                                        Your Trading Bot Platform |
//|                    Strategy: Long & Short SMC Strategy           |
//|                    Improved: Execution + Retries + Logging        |
//+------------------------------------------------------------------+
#property copyright   "FxScalpKing"
#property link        "https://fxscalpking.com"
#property version     "3.01"
#property strict

#include <Trade\Trade.mqh>
#include <Trade\PositionInfo.mqh>
#include <Trade\OrderInfo.mqh>
#include "FxScalpKing_HTTP.mqh"

//+------------------------------------------------------------------+
//| INPUT PARAMETERS                                                 |
//+------------------------------------------------------------------+
// --- BACKEND CONNECTION ---
// ApiKey MUST match the value in your backend .env (EA_API_KEY) / Render Env Vars EXACTLY.
// ServerURL options:
//   [CLOUD]       https://liquibot-back.onrender.com  (default — production)
//   [LOCAL DEV]   http://localhost:5000              (backend on same PC as MT5)
//   [LOCAL LAN]   http://192.168.1.50:5000           (backend on another LAN PC)
// Also allowlist ServerURL in MT5: Tools → Options → Expert Advisors → Allow WebRequest.
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
input int      MaxRetries        = 3; // Max retries for failed orders
input int      RetryDelayMs      = 500; // Delay between retries (ms)

//+------------------------------------------------------------------+
//| GLOBAL VARIABLES                                                 |
//+------------------------------------------------------------------+
CTrade            trade;
CPositionInfo     posInfo;
COrderInfo        ordInfo;
bool              licenseValid      = false;
bool              isPaused          = false;
datetime          lastHeartbeat     = 0;
datetime          lastHeartbeatOk   = 0;
string            lastHeartbeatStatus = "INIT";
int               heartbeatOkCount  = 0;
int               heartbeatFailCount = 0;
int               lastCommandCount  = 0;
int               heartbeatSeq      = 0;
string            EA_Name           = "FxScalpKing EA v3.0";

// Chart history depths (must match app ChartScreen TF_COUNTS)
#define BARS_M5   600
#define BARS_M15  480
#define BARS_H1   400
#define BARS_H4   100
#define BARS_FEAT 600
// Full multi-TF chart is large — sync less often so heartbeats stay reliable.
#define CHART_SYNC_EVERY_N  15

// Indicators
int handle_ema20, handle_ema50, handle_atr;
double g_ema20Prev = 0;

// Pending execution queue
struct PendingOrder {
   ulong commandId;
   string type; // BUY/SELL
   double entryPrice;
   double sl;
   double tp;
   double lotSize;
   ulong ticket; // filled after broker accept
   int retriesUsed;
   int retriesLeft;
   datetime lastAttempt;
};
PendingOrder pendingOrders[];

//+------------------------------------------------------------------+
//| HELPER: extract a JSON number field (best-effort, no full parser)|
//+------------------------------------------------------------------+
double JsonGetNumber(string json, string key, double fallback)
{
   string needle = "\"" + key + "\":";
   int pos = StringFind(json, needle);
   if(pos < 0) return fallback;
   int start = pos + StringLen(needle);
   while(start < StringLen(json) && StringGetCharacter(json, start) == ' ') start++;
   string num = "";
   for(int i = start; i < StringLen(json); i++)
   {
      ushort ch = StringGetCharacter(json, i);
      if((ch >= '0' && ch <= '9') || ch == '.' || ch == '-' || ch == '+')
         num += CharToString((char)ch);
      else
         break;
   }
   if(num == "") return fallback;
   return StringToDouble(num);
}

string JsonGetString(string json, string key, string fallback)
{
   string needle = "\"" + key + "\":\"";
   int pos = StringFind(json, needle);
   if(pos < 0) return fallback;
   int start = pos + StringLen(needle);
   int end = StringFind(json, "\"", start);
   if(end < 0) return fallback;
   return StringSubstr(json, start, end - start);
}

//+------------------------------------------------------------------+
//| HELPER: LOGGING                                                  |
//+------------------------------------------------------------------+
void LogAction(string level, string action, string details)
{
   string timestamp = TimeToString(TimeCurrent(), TIME_DATE|TIME_SECONDS);
   Print("[", timestamp, "] [", level, "] ", action, " - ", details);
}

//+------------------------------------------------------------------+
//| EXPERT INITIALIZATION                                            |
//+------------------------------------------------------------------+
int OnInit()
{
   LogAction("INFO", "INIT", EA_Name + " starting");
   LogAction("INFO", "INIT", "ServerURL=" + ServerURL);
   Comment(EA_Name + "\nConnecting to " + ServerURL + "…\n(Free Render cold start can take ~60s)");

   FxScalpKing.SetServerUrl(ServerURL);
   FxScalpKing.SetApiKey(ApiKey);
   FxScalpKing.SetTimeoutMs(60000);

   string expiry = "", plan = "";
   // Free Render spins down — wake can take 50s+. Retry so init survives cold start.
   if(!FxScalpKing.ValidateLicenseWithRetries(expiry, plan, 10, 5000))
   {
      lastHeartbeatStatus = "LICENSE_FAIL";
      LogAction("ERROR", "LICENSE",
         "Validation failed after retries. Check: (1) ApiKey == Render EA_API_KEY (2) WebRequest allowlist for "
         + ServerURL + " (3) service awake at /test");
      Comment(EA_Name + "\nLICENSE FAIL\n" + ServerURL +
              "\nAllowlist URL in Tools→Options→Expert Advisors\nApiKey must match EA_API_KEY");
      return INIT_FAILED;
   }

   licenseValid = true;
   lastHeartbeatStatus = "LICENSED";
   trade.SetExpertMagicNumber(MagicNumber);
   trade.SetTypeFilling(ORDER_FILLING_IOC);
   trade.SetDeviationInPoints(20); // Allow 20 points deviation for requotes
   trade.SetTypeFilling(ORDER_FILLING_FOK);

   handle_ema20 = iMA(_Symbol, PERIOD_M5, 20, 0, MODE_EMA, PRICE_CLOSE);
   handle_ema50 = iMA(_Symbol, PERIOD_M5, 50, 0, MODE_EMA, PRICE_CLOSE);
   handle_atr   = iATR(_Symbol, PERIOD_M5, 14);

   EventSetTimer(1);
   LogAction("SUCCESS", "INIT", "Initialization complete · plan=" + plan + " expiry=" + expiry);
   UpdateExpertComment();
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   LogAction("INFO", "DEINIT", "Expert deinitialized. Reason: " + IntegerToString(reason));
}

void OnTimer()
{
   if(!licenseValid) return;

   if(TimeCurrent() - lastHeartbeat >= HeartbeatInterval)
   {
      SendHeartbeat();
      PollCommands();
      ProcessPendingOrders();
      lastHeartbeat = TimeCurrent();
      UpdateExpertComment();
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
                     if(trade.PositionModify(posInfo.Ticket(), newSL, posInfo.TakeProfit()))
                     {
                        LogAction("SUCCESS", "TRAIL", "Buy SL updated to " + DoubleToString(newSL, _Digits));
                     }
                     else
                     {
                        LogAction("ERROR", "TRAIL", "Failed to update buy SL. Err: " + IntegerToString(GetLastError()));
                     }
                  }
               }
               else if(posInfo.PositionType() == POSITION_TYPE_SELL)
               {
                  double newSL = posInfo.PriceOpen() - lockPoints * point;
                  if(posInfo.StopLoss() > newSL + 5 * point || posInfo.StopLoss() == 0)
                  {
                     if(trade.PositionModify(posInfo.Ticket(), newSL, posInfo.TakeProfit()))
                     {
                        LogAction("SUCCESS", "TRAIL", "Sell SL updated to " + DoubleToString(newSL, _Digits));
                     }
                     else
                     {
                        LogAction("ERROR", "TRAIL", "Failed to update sell SL. Err: " + IntegerToString(GetLastError()));
                     }
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
   if(!SymbolInfoTick(_Symbol, tick))
   {
      LogAction("WARN", "HEARTBEAT", "Failed to get tick data");
      return;
   }

   double ema20[1], ema50[1], atr[1];
   CopyBuffer(handle_ema20, 0, 0, 1, ema20);
   CopyBuffer(handle_ema50, 0, 0, 1, ema50);
   CopyBuffer(handle_atr, 0, 0, 1, atr);

   string json = "{";
   json += "\"apiKey\":\"" + ApiKey + "\",";
   json += "\"symbol\":\"" + _Symbol + "\",";
   json += "\"timeframe\":\"M5\",";
   json += "\"price\":" + DoubleToString(tick.bid, _Digits) + ",";
   json += "\"spread\":" + DoubleToString((tick.ask - tick.bid)/_Point, 0) + ",";
   json += "\"balance\":" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) + ",";
   json += "\"equity\":" + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2) + ",";
   json += "\"margin\":" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN), 2) + ",";
   json += "\"freeMargin\":" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_FREE), 2) + ",";
   json += "\"marginLevel\":" + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_LEVEL), 2) + ",";
   json += "\"pipSize\":" + DoubleToString((_Digits == 3 || _Digits == 5) ? _Point * 10 : _Point, _Digits) + ",";
   json += "\"pointSize\":" + DoubleToString(_Point, _Digits) + ",";
   json += "\"pipValue\":" + DoubleToString(SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE), 4) + ",";
   json += "\"minLot\":" + DoubleToString(SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN), 2) + ",";
   json += "\"maxLot\":" + DoubleToString(SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX), 2) + ",";
   json += "\"minLotStep\":" + DoubleToString(SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP), 2) + ",";
   json += "\"openPositionsCount\":" + IntegerToString(PositionsTotal()) + ",";
   json += "\"ema20\":" + DoubleToString(ema20[0], _Digits) + ",";
   json += "\"ema20Prev\":" + DoubleToString(g_ema20Prev > 0 ? g_ema20Prev : ema20[0], _Digits) + ",";
   json += "\"ema50\":" + DoubleToString(ema50[0], _Digits) + ",";
   json += "\"atr14\":" + DoubleToString(atr[0], _Digits) + ",";
   json += "\"timestamp\":" + IntegerToString((long)TimeCurrent() * 1000) + ",";
   json += "\"isPaused\":" + (isPaused ? "true" : "false") + ",";
   g_ema20Prev = ema20[0];
   heartbeatSeq++;

   int nM5 = 0, nM15 = 0, nH1 = 0, nH4 = 0;
   // Full multi-TF chart is heavy — include on first HB and every CHART_SYNC_EVERY_N after.
   bool sendChart = (heartbeatSeq == 1) || ((heartbeatSeq % CHART_SYNC_EVERY_N) == 0);
   if(sendChart)
   {
      json += "\"chart\":{";

      json += "\"M5\":[";
      MqlRates ratesM5[];
      ArraySetAsSeries(ratesM5, true);
      nM5 = CopyRates(_Symbol, PERIOD_M5, 0, BARS_M5, ratesM5);
      if(nM5 > 0) {
         for(int i=0; i<nM5; i++) {
            json += "{\"time\":" + IntegerToString((long)ratesM5[i].time) + ",\"timestamp\":" + IntegerToString((long)ratesM5[i].time) + ",\"open\":" + DoubleToString(ratesM5[i].open, _Digits) + ",\"high\":" + DoubleToString(ratesM5[i].high, _Digits) + ",\"low\":" + DoubleToString(ratesM5[i].low, _Digits) + ",\"close\":" + DoubleToString(ratesM5[i].close, _Digits) + ",\"volume\":" + IntegerToString((long)ratesM5[i].tick_volume) + "}";
            if(i < nM5 - 1) json += ",";
         }
      }
      json += "],";

      json += "\"M15\":[";
      MqlRates ratesM15[];
      ArraySetAsSeries(ratesM15, true);
      nM15 = CopyRates(_Symbol, PERIOD_M15, 0, BARS_M15, ratesM15);
      if(nM15 > 0) {
         for(int i=0; i<nM15; i++) {
            json += "{\"time\":" + IntegerToString((long)ratesM15[i].time) + ",\"timestamp\":" + IntegerToString((long)ratesM15[i].time) + ",\"open\":" + DoubleToString(ratesM15[i].open, _Digits) + ",\"high\":" + DoubleToString(ratesM15[i].high, _Digits) + ",\"low\":" + DoubleToString(ratesM15[i].low, _Digits) + ",\"close\":" + DoubleToString(ratesM15[i].close, _Digits) + ",\"volume\":" + IntegerToString((long)ratesM15[i].tick_volume) + "}";
            if(i < nM15 - 1) json += ",";
         }
      }
      json += "],";

      json += "\"H1\":[";
      MqlRates ratesH1[];
      ArraySetAsSeries(ratesH1, true);
      nH1 = CopyRates(_Symbol, PERIOD_H1, 0, BARS_H1, ratesH1);
      if(nH1 > 0) {
         for(int i=0; i<nH1; i++) {
            json += "{\"time\":" + IntegerToString((long)ratesH1[i].time) + ",\"timestamp\":" + IntegerToString((long)ratesH1[i].time) + ",\"open\":" + DoubleToString(ratesH1[i].open, _Digits) + ",\"high\":" + DoubleToString(ratesH1[i].high, _Digits) + ",\"low\":" + DoubleToString(ratesH1[i].low, _Digits) + ",\"close\":" + DoubleToString(ratesH1[i].close, _Digits) + ",\"volume\":" + IntegerToString((long)ratesH1[i].tick_volume) + "}";
            if(i < nH1 - 1) json += ",";
         }
      }
      json += "],";

      json += "\"H4\":[";
      MqlRates ratesH4[];
      ArraySetAsSeries(ratesH4, true);
      nH4 = CopyRates(_Symbol, PERIOD_H4, 0, BARS_H4, ratesH4);
      if(nH4 > 0) {
         for(int i=0; i<nH4; i++) {
            json += "{\"time\":" + IntegerToString((long)ratesH4[i].time) + ",\"timestamp\":" + IntegerToString((long)ratesH4[i].time) + ",\"open\":" + DoubleToString(ratesH4[i].open, _Digits) + ",\"high\":" + DoubleToString(ratesH4[i].high, _Digits) + ",\"low\":" + DoubleToString(ratesH4[i].low, _Digits) + ",\"close\":" + DoubleToString(ratesH4[i].close, _Digits) + ",\"volume\":" + IntegerToString((long)ratesH4[i].tick_volume) + "}";
            if(i < nH4 - 1) json += ",";
         }
      }
      json += "]";

      json += "},";
   }

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

   // Send M5 candles (engine features / signals)
   json += "\"candles\":[";
   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   int lookback = BARS_FEAT;
   int nCandles = CopyRates(_Symbol, PERIOD_M5, 0, lookback, rates);
   if(nCandles > 0)
   {
      for(int i=0; i<nCandles; i++)
      {
         json += "{\"time\":" + IntegerToString((long)rates[i].time) + ",";
         json += "\"timestamp\":" + IntegerToString((long)rates[i].time) + ",";
         json += "\"open\":" + DoubleToString(rates[i].open, _Digits) + ",";
         json += "\"high\":" + DoubleToString(rates[i].high, _Digits) + ",";
         json += "\"low\":" + DoubleToString(rates[i].low, _Digits) + ",";
         json += "\"close\":" + DoubleToString(rates[i].close, _Digits) + ",";
         json += "\"volume\":" + DoubleToString((double)rates[i].tick_volume, 0) + "}";
         if(i < nCandles - 1) json += ",";
      }
   }
   json += "]}";

   string resp;
   double spreadPts = (tick.ask - tick.bid) / _Point;
   if(FxScalpKing.SendHeartbeat(json, resp))
   {
      heartbeatOkCount++;
      lastHeartbeatOk = TimeCurrent();
      lastHeartbeatStatus = "OK";
      LogAction("INFO", "HEARTBEAT",
         "OK · #" + IntegerToString(heartbeatSeq) +
         " " + _Symbol +
         " bid=" + DoubleToString(tick.bid, _Digits) +
         " spread=" + DoubleToString(spreadPts, 0) + "pts" +
         " bal=" + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2) +
         " pos=" + IntegerToString(PositionsTotal()) +
         (sendChart
            ? (" chartBars M5/M15/H1/H4=" + IntegerToString(nM5) + "/" + IntegerToString(nM15) + "/" + IntegerToString(nH1) + "/" + IntegerToString(nH4))
            : " chart=skip") +
         " bytes~" + IntegerToString(StringLen(json)) +
         " queued=" + IntegerToString(ArraySize(pendingOrders)));
   }
   else
   {
      heartbeatFailCount++;
      lastHeartbeatStatus = "FAIL http=" + IntegerToString(FxScalpKing.LastHttpCode()) +
         " err=" + IntegerToString(FxScalpKing.LastError());
      LogAction("ERROR", "HEARTBEAT",
         "Failed · http=" + IntegerToString(FxScalpKing.LastHttpCode()) +
         " err=" + IntegerToString(FxScalpKing.LastError()) +
         " · allowlist " + ServerURL + " · ApiKey must match EA_API_KEY");
   }
}

//+------------------------------------------------------------------+
//| POLL & VALIDATE COMMANDS                                         |
//+------------------------------------------------------------------+
void PollCommands()
{
   string resp = FxScalpKing.GetCommands();
   if(resp == "" || resp == "[]")
   {
      lastCommandCount = 0;
      return;
   }

   LogAction("INFO", "COMMANDS", "Received: " + resp);

   // Walk each object in the JSON array and honour brain-calculated lots/SL/TP.
   int searchFrom = 0;
   int cmdCount = 0;
   while(true)
   {
      int objStart = StringFind(resp, "{", searchFrom);
      if(objStart < 0) break;
      int objEnd = StringFind(resp, "}", objStart);
      if(objEnd < 0) break;
      string obj = StringSubstr(resp, objStart, objEnd - objStart + 1);
      searchFrom = objEnd + 1;
      cmdCount++;

      string action = JsonGetString(obj, "action", "");
      if(action == "") action = JsonGetString(obj, "type", "");

      if(action == "BUY" || action == "SELL")
      {
         double lots = JsonGetNumber(obj, "lots", FixedLotSize);
         double sl = JsonGetNumber(obj, "sl", 0);
         double tp = JsonGetNumber(obj, "tp", 0);
         LogAction("INFO", "COMMAND", action + " lots=" + DoubleToString(lots, 2) +
            " sl=" + DoubleToString(sl, _Digits) + " tp=" + DoubleToString(tp, _Digits));
         QueueOrder(action, lots, sl, tp);
      }
      else if(action == "UPDATE_SL")
      {
         ulong ticket = (ulong)JsonGetNumber(obj, "ticket", 0);
         double sl = JsonGetNumber(obj, "sl", 0);
         if(ticket > 0 && sl > 0 && posInfo.SelectByTicket(ticket))
         {
            if(trade.PositionModify(ticket, sl, posInfo.TakeProfit()))
               LogAction("SUCCESS", "UPDATE_SL", "Ticket " + IntegerToString(ticket) + " SL -> " + DoubleToString(sl, _Digits));
            else
               LogAction("ERROR", "UPDATE_SL", "Failed ticket " + IntegerToString(ticket) + " err=" + IntegerToString(GetLastError()));
         }
      }
      else if(action == "PAUSE") { isPaused = true; LogAction("INFO", "COMMAND", "EA Paused"); }
      else if(action == "RESUME") { isPaused = false; LogAction("INFO", "COMMAND", "EA Resumed"); }
      else if(action == "CLOSE_ALL") CloseAllTrades();
      else if(action == "CONFIG_SYNC") LogAction("INFO", "COMMAND", "CONFIG_SYNC acknowledged");
      else LogAction("WARN", "COMMAND", "Unknown action: " + action);
   }
   lastCommandCount = cmdCount;
}

//+------------------------------------------------------------------+
//| Chart + Experts tab status (Comment + Print)                     |
//+------------------------------------------------------------------+
void UpdateExpertComment()
{
   MqlTick tick;
   double spreadPts = 0;
   if(SymbolInfoTick(_Symbol, tick))
      spreadPts = (tick.ask - tick.bid) / _Point;

   int age = lastHeartbeatOk > 0 ? (int)(TimeCurrent() - lastHeartbeatOk) : -1;
   string line =
      EA_Name + " · " + (licenseValid ? "ONLINE" : "OFFLINE") + "\n" +
      "Server: " + ServerURL + "\n" +
      "HB: " + lastHeartbeatStatus +
         " ok=" + IntegerToString(heartbeatOkCount) +
         " fail=" + IntegerToString(heartbeatFailCount) +
         " age=" + IntegerToString(age) + "s" +
         " seq=" + IntegerToString(heartbeatSeq) + "\n" +
      _Symbol + " spread=" + DoubleToString(spreadPts, 0) + "pts" +
         " bid=" + DoubleToString(tick.bid, _Digits) + "\n" +
      "Paused=" + (isPaused ? "YES" : "NO") +
         " queued=" + IntegerToString(ArraySize(pendingOrders)) +
         " cmds=" + IntegerToString(lastCommandCount) +
         " positions=" + IntegerToString(PositionsTotal()) + "\n" +
      "Bars H4=" + IntegerToString(BARS_H4) +
         " H1=" + IntegerToString(BARS_H1) +
         " M15=" + IntegerToString(BARS_M15) +
         " M5=" + IntegerToString(BARS_M5) +
         " chartEvery=" + IntegerToString(CHART_SYNC_EVERY_N);

   Comment(line);
}

//+------------------------------------------------------------------+
//| QUEUE ORDER                                                      |
//+------------------------------------------------------------------+
void QueueOrder(string type, double lotSize, double brainSL, double brainTP)
{
   if(isPaused)
   {
      LogAction("WARN", "QUEUE", "EA paused, ignoring " + type + " order");
      return;
   }

   // Prefer backend risk-engine SL/TP; fall back to local points if absent.
   double entryPrice, sl, tp;
   if(type == "BUY")
   {
      entryPrice = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
      sl = brainSL > 0 ? brainSL : entryPrice - StopLoss_Points * _Point;
      tp = brainTP > 0 ? brainTP : entryPrice + TakeProfit_Points * _Point;
   }
   else
   {
      entryPrice = SymbolInfoDouble(_Symbol, SYMBOL_BID);
      sl = brainSL > 0 ? brainSL : entryPrice + StopLoss_Points * _Point;
      tp = brainTP > 0 ? brainTP : entryPrice - TakeProfit_Points * _Point;
   }

   if(lotSize <= 0) lotSize = FixedLotSize;

   // Validate command
   if(!ValidateCommand(type, entryPrice, sl, tp, lotSize))
   {
      LogAction("ERROR", "QUEUE", type + " command validation failed");
      return;
   }

   // Add to pending queue
   PendingOrder newOrder;
   newOrder.commandId = (ulong)TimeCurrent() * 1000 + MathRand() % 1000;
   newOrder.type = type;
   newOrder.entryPrice = entryPrice;
   newOrder.sl = sl;
   newOrder.tp = tp;
   newOrder.lotSize = lotSize;
   newOrder.ticket = 0;
   newOrder.retriesUsed = 0;
   newOrder.retriesLeft = MaxRetries;
   newOrder.lastAttempt = 0;

   ArrayResize(pendingOrders, ArraySize(pendingOrders) + 1);
   pendingOrders[ArraySize(pendingOrders)-1] = newOrder;

   LogAction("INFO", "QUEUE", type + " order queued. ID: " + IntegerToString((ulong)newOrder.commandId) +
             " lots=" + DoubleToString(lotSize, 2) + " sl=" + DoubleToString(sl, _Digits) + " tp=" + DoubleToString(tp, _Digits));
}

//+------------------------------------------------------------------+
//| VALIDATE COMMAND                                                 |
//+------------------------------------------------------------------+
bool ValidateCommand(string type, double entryPrice, double sl, double tp, double lotSize)
{
   // Check valid symbol
   if(!SymbolSelect(_Symbol, true))
   {
      LogAction("ERROR", "VALIDATE", "Symbol not selectable: " + _Symbol);
      return false;
   }

   // Check lot size
   double minLot = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double maxLot = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   double lotStep = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);

   if(lotSize < minLot || lotSize > maxLot)
   {
      LogAction("ERROR", "VALIDATE", "Invalid lot size: " + DoubleToString(lotSize,2) + ". Min: " + DoubleToString(minLot,2) + " Max: " + DoubleToString(maxLot,2));
      return false;
   }

   // Check SL/TP levels
   if(type == "BUY" && sl >= entryPrice)
   {
      LogAction("ERROR", "VALIDATE", "Buy SL must be below entry price");
      return false;
   }
   if(type == "SELL" && sl <= entryPrice)
   {
      LogAction("ERROR", "VALIDATE", "Sell SL must be above entry price");
      return false;
   }

   LogAction("SUCCESS", "VALIDATE", type + " command validated");
   return true;
}

//+------------------------------------------------------------------+
//| PROCESS PENDING ORDERS                                           |
//+------------------------------------------------------------------+
void ProcessPendingOrders()
{
   if(ArraySize(pendingOrders) == 0) return;

   for(int i = ArraySize(pendingOrders)-1; i >=0; i--)
   {
      // MQL5 forbids local references to array elements (PendingOrder &x = arr[i])
      PendingOrder order = pendingOrders[i];

      // Check if ready to retry
      ulong now = (ulong)TimeCurrent() * 1000;
      if(now - (ulong)order.lastAttempt * 1000 < (ulong)RetryDelayMs) continue;

      // Attempt execution (may update ticket/entry/sl/tp on the copy)
      bool success = ExecuteOrder(order);
      if(success)
      {
         RemovePendingOrder(i);
      }
      else
      {
         order.retriesLeft--;
         order.retriesUsed++;
         order.lastAttempt = TimeCurrent();
         pendingOrders[i] = order; // write back retry state + any requote SL/TP tweaks

         if(order.retriesLeft <= 0)
         {
            LogAction("ERROR", "EXECUTE", "Order failed permanently. ID: " + IntegerToString((ulong)order.commandId));
            ReportExecutionResult(order, false, "Max retries exceeded");
            RemovePendingOrder(i);
         }
         else
         {
            LogAction("WARN", "EXECUTE", "Retrying order. ID: " + IntegerToString((ulong)order.commandId) + ". Retries left: " + IntegerToString(order.retriesLeft));
         }
      }
   }
}

//+------------------------------------------------------------------+
//| EXECUTE ORDER                                                    |
//+------------------------------------------------------------------+
bool ExecuteOrder(PendingOrder &order)
{
   bool result;

   if(order.type == "BUY")
   {
      result = ExecuteBuy(order);
   }
   else
   {
      result = ExecuteSell(order);
   }

   if(result)
   {
      ReportExecutionResult(order, true, "");
   }

   return result;
}

//+------------------------------------------------------------------+
//| EXECUTE BUY ORDER                                                |
//+------------------------------------------------------------------+
bool ExecuteBuy(PendingOrder &order)
{
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   LogAction("INFO", "EXECUTE", "Executing BUY. Ask: " + DoubleToString(ask, _Digits) + ". SL: " + DoubleToString(order.sl, _Digits) + ". TP: " + DoubleToString(order.tp, _Digits));

   if(trade.Buy(order.lotSize, _Symbol, ask, order.sl, order.tp, "App Brain Buy"))
   {
      ulong ticket = trade.ResultOrder();
      order.ticket = ticket;
      order.entryPrice = trade.ResultPrice() > 0 ? trade.ResultPrice() : ask;
      LogAction("SUCCESS", "EXECUTE", "Buy order executed. Ticket: " + IntegerToString(ticket));
      return true;
   }
   else
   {
      int err = GetLastError();
      LogAction("ERROR", "EXECUTE", "Buy failed. Err: " + IntegerToString(err) + " (" + TradeErrorDescription(err) + ")");

      // Handle requotes (err 138) or reprice (err 137)
      if(err == 138 || err == 137)
      {
         LogAction("WARN", "EXECUTE", "Requote/reprice encountered");
         // Adjust SL/TP slightly for requote
         if(err == 138)
         {
            double newAsk = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
            order.sl = newAsk - StopLoss_Points * _Point;
            order.tp = newAsk + TakeProfit_Points * _Point;
         }
      }

      return false;
   }
}

//+------------------------------------------------------------------+
//| EXECUTE SELL ORDER                                               |
//+------------------------------------------------------------------+
bool ExecuteSell(PendingOrder &order)
{
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   LogAction("INFO", "EXECUTE", "Executing SELL. Bid: " + DoubleToString(bid, _Digits) + ". SL: " + DoubleToString(order.sl, _Digits) + ". TP: " + DoubleToString(order.tp, _Digits));

   if(trade.Sell(order.lotSize, _Symbol, bid, order.sl, order.tp, "App Brain Sell"))
   {
      ulong ticket = trade.ResultOrder();
      order.ticket = ticket;
      order.entryPrice = trade.ResultPrice() > 0 ? trade.ResultPrice() : bid;
      LogAction("SUCCESS", "EXECUTE", "Sell order executed. Ticket: " + IntegerToString(ticket));
      return true;
   }
   else
   {
      int err = GetLastError();
      LogAction("ERROR", "EXECUTE", "Sell failed. Err: " + IntegerToString(err) + " (" + TradeErrorDescription(err) + ")");

      // Handle requotes (err 138) or reprice (err 137)
      if(err == 138 || err == 137)
      {
         LogAction("WARN", "EXECUTE", "Requote/reprice encountered");
         if(err == 138)
         {
            double newBid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
            order.sl = newBid + StopLoss_Points * _Point;
            order.tp = newBid - TakeProfit_Points * _Point;
         }
      }

      return false;
   }
}

//+------------------------------------------------------------------+
//| REMOVE FROM QUEUE                                                |
//+------------------------------------------------------------------+
void RemovePendingOrder(int index)
{
   for(int i = index; i < ArraySize(pendingOrders) -1; i++)
   {
      pendingOrders[i] = pendingOrders[i+1];
   }
   ArrayResize(pendingOrders, ArraySize(pendingOrders)-1);
}

//+------------------------------------------------------------------+
//| REPORT EXECUTION TO SERVER                                       |
//+------------------------------------------------------------------+
void ReportExecutionResult(PendingOrder &order, bool success, string reason)
{
   LogAction(success ? "SUCCESS" : "ERROR", "REPORT", "Execution result: " + (success ? "Success" : "Failed") + (reason != "" ? " - " + reason : ""));

   // Payload MUST match backend eaExecutionReportSchema (ticket + eventType required).
   string eventType = success ? "ORDER_OPEN" : "ERROR";
   ulong ticket = order.ticket > 0 ? order.ticket : order.commandId;
   double spreadPts = (SymbolInfoDouble(_Symbol, SYMBOL_ASK) - SymbolInfoDouble(_Symbol, SYMBOL_BID)) / _Point;

   string json = "{";
   json += "\"ticket\":" + IntegerToString(ticket) + ",";
   json += "\"eventType\":\"" + eventType + "\",";
   json += "\"symbol\":\"" + _Symbol + "\",";
   json += "\"direction\":\"" + order.type + "\",";
   json += "\"requestedPrice\":" + DoubleToString(order.entryPrice, _Digits) + ",";
   json += "\"executionPrice\":" + DoubleToString(order.entryPrice, _Digits) + ",";
   json += "\"spreadAtExecution\":" + DoubleToString(spreadPts, 0) + ",";
   json += "\"lotSize\":" + DoubleToString(order.lotSize, 2) + ",";
   json += "\"sl\":" + DoubleToString(order.sl, _Digits) + ",";
   json += "\"tp\":" + DoubleToString(order.tp, _Digits) + ",";
   json += "\"retriesUsed\":" + IntegerToString(order.retriesUsed) + ",";
   json += "\"eaTimestamp\":" + IntegerToString((long)TimeCurrent() * 1000) + ",";
   json += "\"commandId\":" + IntegerToString((ulong)order.commandId) + ",";
   if(reason != "") json += "\"brokerErrorMessage\":\"" + reason + "\",";
   json += "\"success\":" + (success ? "true" : "false");
   json += "}";

   string response;
   if(FxScalpKing.ReportExecution(json, response))
   {
      LogAction("DEBUG", "REPORT", "Execution report sent");
   }
   else
   {
      LogAction("WARN", "REPORT", "Failed to send execution report");
   }
}

//+------------------------------------------------------------------+
//| TRADE ERROR DESCRIPTIONS                                         |
//+------------------------------------------------------------------+
string TradeErrorDescription(int err)
{
   switch(err)
   {
      case 0: return "No error";
      case 1: return "No error, but result unknown";
      case 2: return "Common error";
      case 3: return "Invalid trade parameters";
      case 4: return "Trade server is busy";
      case 5: return "Old version of terminal";
      case 6: return "No connection with trade server";
      case 7: return "Not enough rights";
      case 8: return "Too frequent requests";
      case 9: return "Malfunctional trade operation";
      case 64: return "Account blocked";
      case 65: return "Invalid account number";
      case 128: return "Trade timeout";
      case 129: return "Invalid price";
      case 130: return "Invalid stops";
      case 131: return "Invalid trade volume";
      case 132: return "Market is closed";
      case 133: return "Trade is disabled";
      case 134: return "Not enough money";
      case 135: return "Price changed";
      case 136: return "No prices";
      case 137: return "Broker is busy";
      case 138: return "Requote";
      case 139: return "Order is locked";
      case 140: return "Only buy allowed";
      case 141: return "Too many requests";
      case 145: return "Modification denied because order too close to market";
      case 146: return "Trade context is busy";
      case 147: return "Trade expiration denied";
      case 148: return "Too many orders";
      case 149: return "Hedge is prohibited";
      case 150: return "Prohibited by FIFO rules";
      default: return "Unknown error";
   }
}

//+------------------------------------------------------------------+
//| CLOSE ALL TRADES                                                 |
//+------------------------------------------------------------------+
void CloseAllTrades()
{
   for(int i=PositionsTotal()-1; i>=0; i--)
   {
      if(posInfo.SelectByIndex(i) && posInfo.Symbol() == _Symbol && posInfo.Magic() == MagicNumber)
      {
         if(trade.PositionClose(posInfo.Ticket()))
         {
            LogAction("SUCCESS", "CLOSE", "Position closed. Ticket: " + IntegerToString(posInfo.Ticket()));
         }
         else
         {
            LogAction("ERROR", "CLOSE", "Failed to close position. Ticket: " + IntegerToString(posInfo.Ticket()) + ". Err: " + IntegerToString(GetLastError()));
         }
      }
   }
   LogAction("INFO", "CLOSE", "Close all command completed");
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
