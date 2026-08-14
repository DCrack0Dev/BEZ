//+------------------------------------------------------------------+
//|                                            ScalpKing_EA_v2.mq5    |
//|                       LiquiBot Gold Trading EA (v2)              |
//|             Smart Money Concepts + ICT Gold Playbook v9          |
//+------------------------------------------------------------------+
#property copyright "LiquiBot"
#property link      "https://liquibot.io"
#property version   "2.1.0"
#property strict

#include <FxScalpKing_HTTP.mqh>

// --- EXPERT INPUTS (user-editable in MT5) ---
input string   EA_API_KEY               = "YOUR_EA_API_KEY_HERE";
input string   ServerURL                = "https://liquibot-back.onrender.com";
input ENUM_TIMEFRAMES SignalTimeframe   = PERIOD_M5;
input int      CandleCount              = 200;
input int      HeartbeatIntervalMs      = 700;
input int      CommandPollIntervalMs    = 500;
input bool     TimezoneTradingEnabled   = false;
input int      MaxSpreadPoints_XAUUSD   = 800;
input bool     NewsFilterActive         = false;
input double   FixedLotSize             = 0.01;
input bool     AutoTradingOnBoot        = true;
input int      MaxClosedTradesHistory   = 50;
input bool     EnableDrawingsOB_FVG     = true;
input int      MagicNumber              = 20260814;

// --- GLOBAL STATE ---
ulong    g_lastHeartbeatSent = 0;
ulong    g_lastCommandPoll   = 0;
string   g_licenseExpiry     = "";
string   g_licensePlan       = "";
bool     g_licenseValid      = false;
bool     g_autoTrading       = true;
double   g_point             = 0;
double   g_pipSize           = 0;
double   g_pipValue          = 0;
int      g_digits            = 0;
datetime g_dealLastSync      = 0;
long     g_closedFromDealId  = 0;
struct ClosedTradeRec { ulong ticket; string symbol; datetime openTime; datetime closeTime;
   double openPrice; double closePrice; double lots; double profit; double pnl;
   double sl; double tp; int type; string reason; };
ClosedTradeRec g_recentClosed[];
int      g_recentClosedCount = 0;
string   g_symbolName        = "";

// --- FORWARD DECLS ---
string   BuildHeartbeatJSON();
void     PollAndExecuteCommands();
bool     ExecuteMarketOrder(string action, double lots, double sl, double tp, ulong &outTicket, string &errMsg);
bool     ModifyPositionSLTP(ulong ticket, double sl, double tp, string &errMsg);
void     SyncRecentClosedHistory(int limit);
string   EscapeJSONString(string s);
string   DoubleToStringPrecise(double v, int digitsOverride = -1);
void     DrawFVG_OB_OnChart();
int      CalculateCandleBodyType(const MqlRates &r, double pipUnit, string &outType, string &outPattern);
double   CalculateEMAMQL(const double &array[], const int rates_total, const int period, const int i);
double   CalculateATRMQL(const MqlRates &rates[], const int rates_total, const int period, const int i);
void     CalculateSwingPoints(const MqlRates &rates[], const int total, const int lookback,
                              double &highs[], int &highCount, double &lows[], int &lowCount);
void     HeartbeatComment(string status, long httpCode, string extra);

//+------------------------------------------------------------------+
//| OnInit                                                            |
//+------------------------------------------------------------------+
int OnInit()
{
   EventSetMillisecondTimer(HeartbeatIntervalMs < 200 ? 200 : HeartbeatIntervalMs);
   g_symbolName = _Symbol;
   g_digits     = (int)SymbolInfoInteger(g_symbolName, SYMBOL_DIGITS);
   g_point      = SymbolInfoDouble(g_symbolName, SYMBOL_POINT);
   bool isXAUUSD = (StringFind(g_symbolName, "XAU") >= 0 || StringFind(g_symbolName, "GOLD") >= 0);
   if(isXAUUSD) { g_pipSize = g_point * 10; } else { g_pipSize = g_point; }
   g_pipValue = SymbolInfoDouble(g_symbolName, SYMBOL_TRADE_TICK_VALUE);
   if(g_pipValue <= 0) g_pipValue = 1.0;
   g_autoTrading = AutoTradingOnBoot;

   FxScalpKing.SetApiKey(EA_API_KEY);
   FxScalpKing.SetServerUrl(ServerURL);

   Print("✅ LiquiBot EA v2 booting — symbol=", g_symbolName,
         " digits=", g_digits, " point=", DoubleToString(g_point, 10),
         " pipSize=", DoubleToString(g_pipSize, 10), " pipValue=", g_pipValue,
         " spread=", SymbolInfoInteger(g_symbolName, SYMBOL_SPREAD));

   g_licenseValid = FxScalpKing.ValidateLicenseWithRetries(g_licenseExpiry, g_licensePlan, 5, 12000);
   if(!g_licenseValid) {
      Print("❌ License FAILED after retries. EA will run read-only (no order execution).");
      HeartbeatComment("LICENSE FAIL", 401, "");
   } else {
      Print("✅ License valid: plan=", g_licensePlan, " expiry=", g_licenseExpiry);
      HeartbeatComment("OK", 200, "plan=" + g_licensePlan);
   }

   SyncRecentClosedHistory(MaxClosedTradesHistory);
   g_dealLastSync = TimeCurrent();
   return(INIT_SUCCEEDED);
}

//+------------------------------------------------------------------+
//| OnDeinit                                                          |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
   Print("🛑 LiquiBot EA stopped (reason=", reason, ")");
}

//+------------------------------------------------------------------+
//| OnTimer — heartbeats + command poll + drawing                    |
//+------------------------------------------------------------------+
void OnTimer()
{
   ulong now = GetTickCount64();

   // 1) Heartbeat POST → /api/ea/update
   if(now - g_lastHeartbeatSent >= (ulong)HeartbeatIntervalMs) {
      g_lastHeartbeatSent = now;
      string payload = BuildHeartbeatJSON();
      string resp;
      bool ok = FxScalpKing.SendHeartbeat(payload, resp);
      int code = FxScalpKing.LastHttpCode();
      if(!ok) {
         HeartbeatComment("HB FAIL", code, "err=" + IntegerToString(FxScalpKing.LastError()));
      } else {
         HeartbeatComment("OK", code, "");
      }
   }

   // 2) Poll GET → /api/ea/commands and execute BUY/SELL/SLTP
   if(now - g_lastCommandPoll >= (ulong)CommandPollIntervalMs) {
      g_lastCommandPoll = now;
      if(g_licenseValid) PollAndExecuteCommands();
   }

   // 3) OB/FVG drawing (toggleable)
   static ulong s_lastDraw = 0;
   if(EnableDrawingsOB_FVG && now - s_lastDraw >= 5000) {
      s_lastDraw = now;
      DrawFVG_OB_OnChart();
   }
}

//+------------------------------------------------------------------+
//| OnTradeTransaction — capture closed deals for history            |
//+------------------------------------------------------------------+
void OnTradeTransaction(const MqlTradeTransaction &trans,
                        const MqlTradeRequest &request,
                        const MqlTradeResult &result)
{
   if(trans.type == TRADE_TRANSACTION_DEAL_ADD || trans.type == TRADE_TRANSACTION_HISTORY_ADD) {
      datetime now = TimeCurrent();
      if(now - g_dealLastSync > 30) {
         g_dealLastSync = now;
         SyncRecentClosedHistory(MaxClosedTradesHistory);
      }
   }
   // Report execution to backend after every order fill
   if(trans.type == TRADE_TRANSACTION_ORDER_ADD || trans.type == TRADE_TRANSACTION_DEAL_ADD) {
      if(trans.deal > 0 || result.deal > 0) {
         ulong ticket   = result.position > 0 ? result.position : trans.position;
         ulong deal     = result.deal > 0 ? result.deal : trans.deal;
         int   retcode  = result.retcode;
         long  entryPriceLong = 0;
         double execPrice = 0;
         if(HistoryDealSelect(deal)) {
            execPrice = HistoryDealGetDouble(deal, DEAL_PRICE);
         }
         long spreadPts = SymbolInfoInteger(g_symbolName, SYMBOL_SPREAD);
         string exJson =
           "{\"ticket\":\"" + IntegerToString(ticket) + "\","
           "\"deal\":\"" + IntegerToString(deal) + "\","
           "\"symbol\":\"" + g_symbolName + "\","
           "\"eventType\":\"" + IntegerToString((int)trans.type) + "\","
           "\"retcode\":" + IntegerToString(retcode) + ","
           "\"volume\":" + DoubleToStringPrecise(request.volume) + ","
           "\"executionPrice\":" + DoubleToStringPrecise(execPrice) + ","
           "\"spreadAtExecution\":" + IntegerToString((int)spreadPts) + ","
           "\"slippagePips\":0,"
           "\"latencyMs\":0,"
           "\"serverTs\":\"" + IntegerToString(TimeCurrent()) + "\"}";
         string ignore;
         FxScalpKing.ReportExecution(exJson, ignore);
      }
   }
}

//+------------------------------------------------------------------+
//| BuildHeartbeatJSON — serialize MT5 state for the backend         |
//+------------------------------------------------------------------+
string BuildHeartbeatJSON()
{
   string out = "{";

   // Basic symbol info
   out += "\"symbol\":\"" + g_symbolName + "\",";
   out += "\"timeframe\":\"M5\",";
   out += "\"autoTradingEnabled\":" + (g_autoTrading ? "true" : "false") + ",";
   out += "\"timezoneTradingEnabled\":" + (TimezoneTradingEnabled ? "true" : "false") + ",";
   out += "\"maxSpreadPoints\":" + IntegerToString(MaxSpreadPoints_XAUUSD) + ",";
   out += "\"newsFilterActive\":" + (NewsFilterActive ? "true" : "false") + ",";

   // Price / spread
   double bid = SymbolInfoDouble(g_symbolName, SYMBOL_BID);
   double ask = SymbolInfoDouble(g_symbolName, SYMBOL_ASK);
   double mid = (bid + ask) / 2.0;
   long   spreadPts = SymbolInfoInteger(g_symbolName, SYMBOL_SPREAD);
   out += "\"price\":" + DoubleToStringPrecise(mid) + ",";
   out += "\"bid\":" + DoubleToStringPrecise(bid) + ",";
   out += "\"ask\":" + DoubleToStringPrecise(ask) + ",";
   out += "\"spread\":" + IntegerToString((int)spreadPts) + ",";

   // Account
   out += "\"balance\":" + DoubleToStringPrecise(AccountInfoDouble(ACCOUNT_BALANCE)) + ",";
   out += "\"equity\":" + DoubleToStringPrecise(AccountInfoDouble(ACCOUNT_EQUITY)) + ",";
   out += "\"currency\":\"" + AccountInfoString(ACCOUNT_CURRENCY) + "\",";
   double freeMargin = AccountInfoDouble(ACCOUNT_FREEMARGIN);
   double margin = AccountInfoDouble(ACCOUNT_MARGIN);
   double marginLevel = margin > 0 ? (AccountInfoDouble(ACCOUNT_EQUITY) / margin) * 100.0 : 9999;
   out += "\"freeMargin\":" + DoubleToStringPrecise(freeMargin) + ",";
   out += "\"margin\":" + DoubleToStringPrecise(margin) + ",";
   out += "\"marginLevel\":" + DoubleToStringPrecise(marginLevel, 2) + ",";
   double dailyLossPct = 0.0;
   double startDayBalance = AccountInfoDouble(ACCOUNT_BALANCE) - AccountInfoDouble(ACCOUNT_PROFIT);
   if(startDayBalance > 0) dailyLossPct = (-AccountInfoDouble(ACCOUNT_PROFIT) / startDayBalance) * 100.0;
   if(dailyLossPct < 0) dailyLossPct = 0;
   out += "\"dailyLossPercent\":" + DoubleToStringPrecise(dailyLossPct, 3) + ",";

   // Unit metadata
   out += "\"pipSize\":" + DoubleToStringPrecise(g_pipSize) + ",";
   out += "\"pointSize\":" + DoubleToStringPrecise(g_point) + ",";
   out += "\"pipValue\":" + DoubleToStringPrecise(g_pipValue) + ",";
   double minLot = SymbolInfoDouble(g_symbolName, SYMBOL_VOLUME_MIN);
   double maxLot = SymbolInfoDouble(g_symbolName, SYMBOL_VOLUME_MAX);
   double stepLot = SymbolInfoDouble(g_symbolName, SYMBOL_VOLUME_STEP);
   out += "\"minLot\":" + DoubleToStringPrecise(minLot, 2) + ",";
   out += "\"maxLot\":" + DoubleToStringPrecise(maxLot, 2) + ",";
   out += "\"minLotStep\":" + DoubleToStringPrecise(stepLot, 2) + ",";

   // --- Candles (M5, sorted oldest→newest) ---
   MqlRates rates[];
   int copied = CopyRates(g_symbolName, SignalTimeframe, 0, CandleCount, rates);
   int ratesTotal = copied < 0 ? 0 : copied;
   out += "\"candles\":[";
   for(int i = ratesTotal - 1; i >= 0; i--) {
      if(i < ratesTotal - 1) out += ",";
      out += "{";
      out += "\"timestamp\":" + IntegerToString((long)rates[i].time * 1000) + ",";
      out += "\"open\":" + DoubleToStringPrecise(rates[i].open) + ",";
      out += "\"high\":" + DoubleToStringPrecise(rates[i].high) + ",";
      out += "\"low\":" + DoubleToStringPrecise(rates[i].low) + ",";
      out += "\"close\":" + DoubleToStringPrecise(rates[i].close) + ",";
      out += "\"volume\":" + IntegerToString((long)rates[i].tick_volume);
      out += "}";
   }
   out += "],";

   // --- Indicator values derived from rates (EMA20, EMA50, ATR14, Swings) ---
   if(ratesTotal >= 55) {
      double closes[];
      ArrayResize(closes, ratesTotal);
      for(int i = 0; i < ratesTotal; i++) closes[i] = rates[i].close;
      double ema20 = CalculateEMAMQL(closes, ratesTotal, 20, 0);
      double ema20Prev = CalculateEMAMQL(closes, ratesTotal, 20, 1);
      double atr14 = CalculateATRMQL(rates, ratesTotal, 14, 0);
      out += "\"ema20\":" + DoubleToStringPrecise(ema20) + ",";
      out += "\"ema20Prev\":" + DoubleToStringPrecise(ema20Prev) + ",";
      out += "\"atr14\":" + DoubleToStringPrecise(atr14) + ",";

      double swingHighArr[], swingLowArr[];
      int shCount=0, slCount=0;
      CalculateSwingPoints(rates, ratesTotal, 2, swingHighArr, shCount, swingLowArr, slCount);
      out += "\"swingHighs\":[";
      for(int k = 0; k < shCount; k++) {
         if(k > 0) out += ",";
         out += DoubleToStringPrecise(swingHighArr[k]);
      }
      out += "],";
      out += "\"swingLows\":[";
      for(int k = 0; k < slCount; k++) {
         if(k > 0) out += ",";
         out += DoubleToStringPrecise(swingLowArr[k]);
      }
      out += "],";
   } else {
      out += "\"ema20\":0,\"ema20Prev\":0,\"atr14\":0,\"swingHighs\":[],\"swingLows\":[],";
   }

   // --- Open positions ---
   ulong posTickets[];
   int posCount = PositionsTotal();
   int posInSymbol = 0;
   string posJson = "[";
   for(int i = 0; i < posCount; i++) {
      ulong t = PositionGetTicket(i);
      if(t == 0) continue;
      if(!PositionSelectByTicket(t)) continue;
      string pSym = PositionGetString(POSITION_SYMBOL);
      if(pSym != g_symbolName) continue;
      long posMagic = PositionGetInteger(POSITION_MAGIC);
      // Include all positions from this symbol; also include our magic but never filter out user trades
      double vol = PositionGetDouble(POSITION_VOLUME);
      double pOpen = PositionGetDouble(POSITION_PRICE_OPEN);
      double pSl   = PositionGetDouble(POSITION_SL);
      double pTp   = PositionGetDouble(POSITION_TP);
      double pPnl  = PositionGetDouble(POSITION_PROFIT);
      ENUM_POSITION_TYPE pType = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
      int pTypeInt = (pType == POSITION_TYPE_BUY) ? 0 : 1;
      if(posInSymbol > 0) posJson += ",";
      posJson += "{";
      posJson += "\"ticket\":\"" + IntegerToString(t) + "\",";
      posJson += "\"ticketNum\":" + IntegerToString(t) + ",";
      posJson += "\"symbol\":\"" + pSym + "\",";
      posJson += "\"type\":" + IntegerToString(pTypeInt) + ",";
      posJson += "\"typeName\":\"" + (pType == POSITION_TYPE_BUY ? "BUY" : "SELL") + "\",";
      posJson += "\"magic\":" + IntegerToString((int)posMagic) + ",";
      posJson += "\"lots\":" + DoubleToStringPrecise(vol, 2) + ",";
      posJson += "\"volume\":" + DoubleToStringPrecise(vol, 2) + ",";
      posJson += "\"openPrice\":" + DoubleToStringPrecise(pOpen) + ",";
      posJson += "\"price\":" + DoubleToStringPrecise(pOpen) + ",";
      posJson += "\"sl\":" + DoubleToStringPrecise(pSl) + ",";
      posJson += "\"tp\":" + DoubleToStringPrecise(pTp) + ",";
      posJson += "\"profit\":" + DoubleToStringPrecise(pPnl, 2) + ",";
      posJson += "\"pnl\":" + DoubleToStringPrecise(pPnl, 2) + ",";
      posJson += "\"openTime\":\"" + IntegerToString((long)PositionGetInteger(POSITION_TIME)) + "\"";
      posJson += "}";
      posInSymbol++;
   }
   posJson += "]";
   out += "\"positions\":" + posJson + ",";
   out += "\"openPositions\":" + posJson + ",";
   out += "\"openPositionsCount\":" + IntegerToString(posInSymbol) + ",";

   // --- Closed trades (history) ---
   SyncRecentClosedHistory(MaxClosedTradesHistory);
   string closedJson = "[";
   for(int c = 0; c < g_recentClosedCount; c++) {
      if(c > 0) closedJson += ",";
      ClosedTradeRec &r = g_recentClosed[c];
      closedJson += "{";
      closedJson += "\"ticket\":\"" + IntegerToString(r.ticket) + "\",";
      closedJson += "\"ticketNum\":" + IntegerToString(r.ticket) + ",";
      closedJson += "\"symbol\":\"" + r.symbol + "\",";
      closedJson += "\"type\":" + IntegerToString(r.type) + ",";
      closedJson += "\"typeName\":\"" + (r.type == 0 ? "BUY" : "SELL") + "\",";
      closedJson += "\"lots\":" + DoubleToStringPrecise(r.lots, 2) + ",";
      closedJson += "\"openPrice\":" + DoubleToStringPrecise(r.openPrice) + ",";
      closedJson += "\"closePrice\":" + DoubleToStringPrecise(r.closePrice) + ",";
      closedJson += "\"sl\":" + DoubleToStringPrecise(r.sl) + ",";
      closedJson += "\"tp\":" + DoubleToStringPrecise(r.tp) + ",";
      closedJson += "\"profit\":" + DoubleToStringPrecise(r.profit, 2) + ",";
      closedJson += "\"pnl\":" + DoubleToStringPrecise(r.pnl, 2) + ",";
      closedJson += "\"profitPips\":" + DoubleToStringPrecise(r.profit, 2) + ",";
      closedJson += "\"reason\":\"" + EscapeJSONString(r.reason) + "\",";
      closedJson += "\"openTime\":\"" + IntegerToString((long)r.openTime) + "\",";
      closedJson += "\"closeTime\":\"" + IntegerToString((long)r.closeTime) + "\"";
      closedJson += "}";
   }
   closedJson += "]";
   out += "\"closedTrades\":" + closedJson + ",";

   out += "\"serverTs\":\"" + IntegerToString((long)TimeCurrent()) + "\",";
   out += "\"eaVersion\":\"2.1.0\"";
   out += "}";
   return out;
}

//+------------------------------------------------------------------+
//| PollAndExecuteCommands                                            |
//+------------------------------------------------------------------+
void PollAndExecuteCommands()
{
   string commandsStr = FxScalpKing.GetCommands();
   if(commandsStr == "") return;

   // Parse lightweight: split on {"action": with simple scan
   int cursor = 0;
   while(cursor < StringLen(commandsStr)) {
      int openBraces = StringFind(commandsStr, "{", cursor);
      if(openBraces < 0) break;
      int closeBraces = -1;
      int depth = 0;
      for(int p = openBraces; p < StringLen(commandsStr); p++) {
         ushort ch;
         if(StringGetCharacter(commandsStr, p, ch)) {
            if(ch == '{') depth++;
            else if(ch == '}') {
               depth--;
               if(depth == 0) { closeBraces = p; break; }
            }
         }
      }
      if(closeBraces < 0) break;
      string oneCmd = StringSubstr(commandsStr, openBraces, closeBraces - openBraces + 1);
      cursor = closeBraces + 1;

      // Extract action, lots, sl, tp, symbol
      string action = "";
      double lots = 0, sl = 0, tp = 0;
      string tktStr = "";

      if(StringFind(oneCmd, "\"action\":\"") >= 0) {
         int p1 = StringFind(oneCmd, "\"action\":\"") + 10;
         int p2 = StringFind(oneCmd, "\"", p1);
         if(p2 > p1) action = StringSubstr(oneCmd, p1, p2 - p1);
      } else if(StringFind(oneCmd, "\"action\":") >= 0) {
         int p1 = StringFind(oneCmd, "\"action\":") + 9;
         while(p1 < StringLen(oneCmd) && StringGetChar(oneCmd, p1) == ' ') p1++;
         if(StringGetChar(oneCmd, p1) == '"') {
            p1++;
            int p2 = StringFind(oneCmd, "\"", p1);
            if(p2 > p1) action = StringSubstr(oneCmd, p1, p2 - p1);
         }
      }
      action = StringUpper(action);

      // lots / sl / tp numeric extract
      double *doubles[];
      string keys[5] = { "\"lots\"", "\"lotSize\"", "\"sl\"", "\"tp\"", "\"ticket\"" };
      double vals[4] = { 0, 0, 0, 0 }; // lots, lotSize, sl, tp
      for(int k = 0; k < 4; k++) {
         int pk = StringFind(oneCmd, keys[k]);
         if(pk < 0) { if(k == 1) continue; } else {
            int colon = StringFind(oneCmd, ":", pk);
            if(colon > pk) {
               int start = colon + 1;
               while(start < StringLen(oneCmd)) {
                  ushort ch2; StringGetCharacter(oneCmd, start, ch2);
                  if(ch2 == ' ' || ch2 == '\t') start++; else break;
               }
               int end = start;
               while(end < StringLen(oneCmd)) {
                  ushort ch3; StringGetCharacter(oneCmd, end, ch3);
                  bool ok = (ch3 >= '0' && ch3 <= '9') || ch3 == '.' || ch3 == '-' || ch3 == 'e' || ch3 == 'E' || ch3 == '+';
                  if(!ok) break;
                  end++;
               }
               if(end > start) {
                  string numStr = StringSubstr(oneCmd, start, end - start);
                  vals[k] = StringToDouble(numStr);
               }
            }
         }
      }
      lots = vals[0] > 0 ? vals[0] : (vals[1] > 0 ? vals[1] : FixedLotSize);
      sl = vals[2];
      tp = vals[3];
      // ticket extract
      {
         int ptk = StringFind(oneCmd, "\"ticket\"");
         if(ptk >= 0) {
            int col2 = StringFind(oneCmd, ":", ptk);
            if(col2 > ptk) {
               int s2 = col2 + 1;
               while(s2 < StringLen(oneCmd)) { ushort ch; StringGetCharacter(oneCmd, s2, ch); if(ch == ' ' || ch == '"' || ch == '\'') s2++; else break; }
               int e2 = s2;
               while(e2 < StringLen(oneCmd)) { ushort ch; StringGetCharacter(oneCmd, e2, ch); if((ch >= '0' && ch <= '9')) e2++; else break; }
               if(e2 > s2) tktStr = StringSubstr(oneCmd, s2, e2 - s2);
            }
         }
      }

      // --- Execute command ---
      if(action == "BUY" || action == "SELL") {
         if(!g_autoTrading) { Print("⚠️ Auto-trading disabled; skipping ", action); continue; }
         ulong outTicket = 0;
         string errMsg;
         bool ok = ExecuteMarketOrder(action, lots, sl, tp, outTicket, errMsg);
         Print(ok ? "✅ " : "❌ ", action, " lots=", DoubleToString(lots, 2),
               " sl=", DoubleToString(sl), " tp=", DoubleToString(tp),
               " ticket=", outTicket, ok ? "" : (" err=" + errMsg));
      }
      else if(action == "MODIFY" || action == "MODIFY_SLTP" || action == "UPDATE_SLTP") {
         ulong tk = StringToInteger(tktStr);
         if(tk == 0) continue;
         string errMsg;
         bool ok = ModifyPositionSLTP(tk, sl, tp, errMsg);
         Print(ok ? "🔧 SLTP updated ticket=" : "❌ SLTP fail ticket=", tk,
               " sl=", DoubleToString(sl), " tp=", DoubleToString(tp), ok ? "" : (" err=" + errMsg));
      }
      else if(action == "CONFIG_SYNC") {
         if(StringFind(oneCmd, "\"autoTradingEnabled\":true") >= 0) g_autoTrading = true;
         if(StringFind(oneCmd, "\"autoTradingEnabled\":false") >= 0) g_autoTrading = false;
         if(StringFind(oneCmd, "\"timezoneTradingEnabled\":true") >= 0) {
            GlobalVariableSet("LB_TIMEZONE_TRADING", 1);
         } else if(StringFind(oneCmd, "\"timezoneTradingEnabled\":false") >= 0) {
            GlobalVariableSet("LB_TIMEZONE_TRADING", 0);
         }
      }
      else if(action == "CLOSE") {
         ulong tk = StringToInteger(tktStr);
         if(tk == 0) continue;
         if(!PositionSelectByTicket(tk)) continue;
         ENUM_POSITION_TYPE pt = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
         MqlTradeRequest closeReq = {0};
         MqlTradeResult closeRes = {0};
         closeReq.magic    = MagicNumber;
         closeReq.action   = TRADE_ACTION_DEAL;
         closeReq.symbol   = g_symbolName;
         closeReq.volume   = PositionGetDouble(POSITION_VOLUME);
         closeReq.deviation= 30;
         closeReq.type     = (pt == POSITION_TYPE_BUY) ? ORDER_TYPE_SELL : ORDER_TYPE_BUY;
         closeReq.position = tk;
         closeReq.price    = (pt == POSITION_TYPE_BUY)
                              ? SymbolInfoDouble(g_symbolName, SYMBOL_BID)
                              : SymbolInfoDouble(g_symbolName, SYMBOL_ASK);
         bool filled = OrderSend(closeReq, closeRes);
         Print(filled ? "🔒 Closed ticket " : "❌ Close fail ticket ", tk,
               " retcode=", closeRes.retcode, " deal=", closeRes.deal);
      }
   }
}

//+------------------------------------------------------------------+
//| ExecuteMarketOrder                                                |
//+------------------------------------------------------------------+
bool ExecuteMarketOrder(string action, double lots, double sl, double tp, ulong &outTicket, string &errMsg)
{
   outTicket = 0;
   errMsg = "";
   MqlTradeRequest req = {0};
   MqlTradeResult res = {0};
   req.magic     = MagicNumber;
   req.action    = TRADE_ACTION_DEAL;
   req.symbol    = g_symbolName;
   req.volume    = lots;
   req.sl        = sl;
   req.tp        = tp;
   req.deviation = 50;
   req.type_filling = ORDER_FILLING_IOC;
   if(action == "BUY") {
      req.type  = ORDER_TYPE_BUY;
      req.price = SymbolInfoDouble(g_symbolName, SYMBOL_ASK);
   } else {
      req.type  = ORDER_TYPE_SELL;
      req.price = SymbolInfoDouble(g_symbolName, SYMBOL_BID);
   }
   bool ok = OrderSend(req, res);
   if(!ok) {
      errMsg = "retcode=" + IntegerToString(res.retcode) + " " + EnumToString((ENUM_ORDER_RETCODE)res.retcode);
      return false;
   }
   if(res.position > 0) outTicket = res.position;
   return true;
}

//+------------------------------------------------------------------+
//| ModifyPositionSLTP                                                |
//+------------------------------------------------------------------+
bool ModifyPositionSLTP(ulong ticket, double sl, double tp, string &errMsg)
{
   errMsg = "";
   if(!PositionSelectByTicket(ticket)) { errMsg = "position not found"; return false; }
   MqlTradeRequest req = {0};
   MqlTradeResult res = {0};
   req.action   = TRADE_ACTION_SLTP;
   req.position = ticket;
   req.symbol   = g_symbolName;
   req.sl       = sl;
   req.tp       = tp;
   req.magic    = MagicNumber;
   bool ok = OrderSend(req, res);
   if(!ok) errMsg = "retcode=" + IntegerToString(res.retcode);
   return ok;
}

//+------------------------------------------------------------------+
//| SyncRecentClosedHistory — populate g_recentClosed from terminal   |
//+------------------------------------------------------------------+
void SyncRecentClosedHistory(int limit)
{
   if(limit < 1) limit = 1;
   ArrayResize(g_recentClosed, limit);
   g_recentClosedCount = 0;

   datetime to = TimeCurrent();
   datetime from = to - 7 * 24 * 3600;
   HistorySelect(from, to);
   HistorySelect(from, to);

   int deals = HistoryDealsTotal();
   ClosedTradeRec tmp[];
   ArrayResize(tmp, deals + 2);
   int count = 0;

   for(int d = deals - 1; d >= 0 && count < limit * 2; d--) {
      ulong dealTkt = HistoryDealGetTicket(d);
      if(dealTkt == 0) continue;
      string dSym = HistoryDealGetString(dealTkt, DEAL_SYMBOL);
      if(dSym != g_symbolName) continue;
      ENUM_DEAL_ENTRY entry = (ENUM_DEAL_ENTRY)HistoryDealGetInteger(dealTkt, DEAL_ENTRY);
      if(entry != DEAL_ENTRY_OUT) continue;
      ulong posTicket = HistoryDealGetInteger(dealTkt, DEAL_POSITION_ID);
      if(posTicket == 0) continue;
      double dProfit = HistoryDealGetDouble(dealTkt, DEAL_PROFIT) +
                       HistoryDealGetDouble(dealTkt, DEAL_SWAP) +
                       HistoryDealGetDouble(dealTkt, DEAL_COMMISSION);
      double dLots   = HistoryDealGetDouble(dealTkt, DEAL_VOLUME);
      double dClose  = HistoryDealGetDouble(dealTkt, DEAL_PRICE);
      datetime dCloseTime = (datetime)HistoryDealGetInteger(dealTkt, DEAL_TIME);
      ENUM_DEAL_TYPE dType = (ENUM_DEAL_TYPE)HistoryDealGetInteger(dealTkt, DEAL_TYPE);
      int typeInt = (dType == DEAL_TYPE_BUY) ? 0 : 1;
      double dOpen = 0; datetime dOpenTime = 0; double dSl=0, dTp=0; string dReason = "";
      // Try to find the matching IN deal for this position id
      for(int dd = deals - 1; dd >= 0; dd--) {
         ulong dtkt = HistoryDealGetTicket(dd);
         if(dtkt == 0) continue;
         if((ulong)HistoryDealGetInteger(dtkt, DEAL_POSITION_ID) != posTicket) continue;
         ENUM_DEAL_ENTRY e = (ENUM_DEAL_ENTRY)HistoryDealGetInteger(dtkt, DEAL_ENTRY);
         if(e != DEAL_ENTRY_IN && e != DEAL_ENTRY_IN_BY_MARGIN) continue;
         if(HistoryDealGetString(dtkt, DEAL_SYMBOL) != g_symbolName) continue;
         dOpen = HistoryDealGetDouble(dtkt, DEAL_PRICE);
         dOpenTime = (datetime)HistoryDealGetInteger(dtkt, DEAL_TIME);
         break;
      }
      // Reason code approximation
      long reasonLong = HistoryDealGetInteger(dealTkt, DEAL_REASON);
      if(reasonLong == DEAL_REASON_SL) dReason = "TP";
      else if(reasonLong == DEAL_REASON_TP) dReason = "SL";
      else if(reasonLong == DEAL_REASON_CLIENT) dReason = "MANUAL_CLOSE";
      else if(reasonLong == DEAL_REASON_EXPERT) dReason = "EA_CLOSE";
      else dReason = "CLOSED_BY_BROKER";
      // Dedup by pos ticket
      bool dup = false;
      for(int k = 0; k < count; k++) {
         if(tmp[k].ticket == posTicket) { dup = true; break; }
      }
      if(dup) continue;
      ClosedTradeRec r;
      r.ticket = posTicket;
      r.symbol = dSym;
      r.openTime = dOpenTime;
      r.closeTime = dCloseTime;
      r.openPrice = dOpen;
      r.closePrice = dClose;
      r.lots = dLots;
      r.profit = dProfit;
      r.pnl = dProfit;
      r.sl = dSl;
      r.tp = dTp;
      r.type = typeInt;
      r.reason = dReason;
      tmp[count++] = r;
      if(count >= limit) break;
   }
   for(int i = 0; i < count; i++) g_recentClosed[i] = tmp[i];
   g_recentClosedCount = count;
}

//+------------------------------------------------------------------+
//| Small helpers                                                      |
//+------------------------------------------------------------------+
string EscapeJSONString(string s)
{
   string outStr = "";
   for(int i = 0; i < StringLen(s); i++) {
      ushort c;
      StringGetCharacter(s, i, c);
      if(c == '"') outStr += "\\\"";
      else if(c == '\\') outStr += "\\\\";
      else if(c == '\n') outStr += "\\n";
      else if(c == '\r') outStr += "\\r";
      else if(c == '\t') outStr += "\\t";
      else outStr += ShortToString(c);
   }
   return outStr;
}

string DoubleToStringPrecise(double v, int digitsOverride = -1)
{
   int d = digitsOverride >= 0 ? digitsOverride : g_digits;
   if(d < 0) d = 5;
   string s = DoubleToString(v, d);
   return s;
}

void HeartbeatComment(string status, long httpCode, string extra)
{
   string s =
      "LiquiBot EA v2.1.0 | " +
      g_symbolName + " | " +
      "HB: " + status + " (" + IntegerToString((int)httpCode) + ") | " +
      "Auto: " + (g_autoTrading ? "ON" : "OFF") + " | " +
      "License: " + (g_licenseValid ? "OK" : "FAIL") +
      (extra != "" ? (" | " + extra) : "");
   Comment(s);
}

//+------------------------------------------------------------------+
//| Indicator math                                                     |
//+------------------------------------------------------------------+
double CalculateEMAMQL(const double &array[], const int rates_total, const int period, const int i)
{
   if(rates_total < period || i >= rates_total) return 0;
   double k = 2.0 / (period + 1.0);
   double ema = 0.0;
   int startIdx = rates_total - 1;
   int endIdx = i;
   if(startIdx < period - 1) return 0;
   double sma = 0.0;
   for(int j = startIdx; j >= startIdx - period + 1 && j >= 0; j--) sma += array[j];
   sma /= (double)period;
   ema = sma;
   for(int j = startIdx - period; j >= endIdx && j >= 0; j--) {
      ema = k * array[j] + (1.0 - k) * ema;
   }
   return ema;
}

double CalculateATRMQL(const MqlRates &rates[], const int rates_total, const int period, const int i)
{
   if(rates_total < period + 1 || i + period >= rates_total) return 0;
   double trSum = 0.0;
   for(int j = i; j < i + period && j + 1 < rates_total; j++) {
      double high = rates[j].high;
      double low  = rates[j].low;
      double prevClose = rates[j + 1].close;
      double tr = MathMax(high - low, MathMax(MathAbs(high - prevClose), MathAbs(low - prevClose)));
      trSum += tr;
   }
   return trSum / (double)period;
}

void CalculateSwingPoints(const MqlRates &rates[], const int total, const int lookback,
                          double &highs[], int &highCount, double &lows[], int &lowCount)
{
   ArrayResize(highs, total);
   ArrayResize(lows, total);
   highCount = 0; lowCount = 0;
   for(int i = lookback; i + lookback < total; i++) {
      bool isHi = true;
      for(int k = 1; k <= lookback; k++) {
         if(rates[i].high <= rates[i - k].high || rates[i].high <= rates[i + k].high) { isHi = false; break; }
      }
      if(isHi) highs[highCount++] = rates[i].high;
      bool isLo = true;
      for(int k = 1; k <= lookback; k++) {
         if(rates[i].low >= rates[i - k].low || rates[i].low >= rates[i + k].low) { isLo = false; break; }
      }
      if(isLo) lows[lowCount++] = rates[i].low;
   }
}

int CalculateCandleBodyType(const MqlRates &r, double pipUnit, string &outType, string &outPattern)
{
   double body = MathAbs(r.close - r.open);
   double range = MathMax(0.00000001, r.high - r.low);
   double bodyPct = range > 0 ? body / range : 0;
   double upperW = r.high - MathMax(r.open, r.close);
   double lowerW = MathMin(r.open, r.close) - r.low;
   bool isBull = r.close >= r.open;
   outType = "NONE"; outPattern = "NONE";
   if(pipUnit <= 0) pipUnit = g_point;
   if(bodyPct >= 0.9) { outType = "MARUBOZU"; return 1; }
   if(isBull) {
      if(lowerW > body * 2.0 && upperW < body * 0.6) { outType = "HAMMER"; return 2; }
   } else {
      if(upperW > body * 2.0 && lowerW < body * 0.6) { outType = "SHOOTING_STAR"; return 3; }
   }
   return 0;
}

//+------------------------------------------------------------------+
//| DrawFVG_OB_OnChart — visualize OB/FVG on chart via Trendlines     |
//+------------------------------------------------------------------+
void DrawFVG_OB_OnChart()
{
   MqlRates rates[];
   int copied = CopyRates(g_symbolName, SignalTimeframe, 0, 100, rates);
   if(copied < 5) return;
   for(int i = 0; i < 20; i++) {
      ObjectDelete(0, "LB_OB_" + IntegerToString(i));
      ObjectDelete(0, "LB_FVG_" + IntegerToString(i));
   }
   int fvgCount = 0, obCount = 0;
   for(int i = copied - 4; i >= 2 && fvgCount < 15; i--) {
      double prev = rates[i + 1].high;
      double curr = rates[i].low;
      if(curr > prev) {
         double size = curr - prev;
         if(size <= g_point * 5) continue;
         datetime t1 = rates[i].time;
         datetime t2 = TimeCurrent() + 60 * 30;
         string name = "LB_FVG_" + IntegerToString(fvgCount++);
         long clr = clrLime;
         ObjectCreate(0, name, OBJ_RECTANGLE, 0, t1, prev, t2, curr);
         ObjectSetInteger(0, name, OBJPROP_COLOR, clr);
         ObjectSetInteger(0, name, OBJPROP_BACK, true);
         ObjectSetInteger(0, name, OBJPROP_STYLE, STYLE_SOLID);
         ObjectSetInteger(0, name, OBJPROP_WIDTH, 1);
         ObjectSetInteger(0, name, OBJPROP_FILL, true);
         ObjectSetInteger(0, name, OBJPROP_ZORDER, 0);
      }
      double prevL = rates[i + 1].low;
      double currH = rates[i].high;
      if(currH < prevL) {
         double sz = prevL - currH;
         if(sz <= g_point * 5) continue;
         datetime t1 = rates[i].time;
         datetime t2 = TimeCurrent() + 60 * 30;
         string name = "LB_FVG_" + IntegerToString(fvgCount++);
         ObjectCreate(0, name, OBJ_RECTANGLE, 0, t1, currH, t2, prevL);
         ObjectSetInteger(0, name, OBJPROP_COLOR, clrTomato);
         ObjectSetInteger(0, name, OBJPROP_BACK, true);
         ObjectSetInteger(0, name, OBJPROP_FILL, true);
      }
   }
   // Simple OB: 3-bar last-down-up pattern coloring
   for(int i = copied - 6; i >= 3 && obCount < 10; i--) {
      bool isBullOB = rates[i + 2].close < rates[i + 2].open &&
                      rates[i + 1].close < rates[i + 1].open &&
                      rates[i].close > rates[i].open;
      bool isBearOB = rates[i + 2].close > rates[i + 2].open &&
                      rates[i + 1].close > rates[i + 1].open &&
                      rates[i].close < rates[i].open;
      if(isBullOB || isBearOB) {
         double bot = MathMin(rates[i + 2].low, MathMin(rates[i + 1].low, rates[i].low));
         double top = MathMax(rates[i + 2].high, MathMax(rates[i + 1].high, rates[i].high));
         datetime t1 = rates[i].time;
         datetime t2 = TimeCurrent() + 60 * 60;
         string nm = "LB_OB_" + IntegerToString(obCount++);
         ObjectCreate(0, nm, OBJ_RECTANGLE, 0, t1, bot, t2, top);
         ObjectSetInteger(0, nm, OBJPROP_COLOR, isBullOB ? clrAqua : clrMagenta);
         ObjectSetInteger(0, nm, OBJPROP_BACK, true);
         ObjectSetInteger(0, nm, OBJPROP_STYLE, STYLE_DOT);
      }
   }
   ChartRedraw();
}
//+------------------------------------------------------------------+
