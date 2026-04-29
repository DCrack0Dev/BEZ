//+------------------------------------------------------------------+
//|                                        FxScalpKing_HTTP.mqh       |
//|                                      FxScalpKing Integration      |
//|                         For use with FxScalpKing EA v1.0+        |
//+------------------------------------------------------------------+

#ifndef FXSCALPKING_HTTP_MQH
#define FXSCALPKING_HTTP_MQH

//+------------------------------------------------------------------+
//| CONFIGURATION                                                    |
//+------------------------------------------------------------------+
// UPDATE THIS TO YOUR BACKEND URL
// For local development: use your computer's local IP address
// Example: "http://192.168.8.151:5000"
#define API_BASE_URL "http://YOUR_SERVER_IP:5000"

//+------------------------------------------------------------------+
//| HTTP CLIENT CLASS                                                |
//+------------------------------------------------------------------+
class CFxScalpKingHTTP
{
private:
   string      m_apiKey;
   string      m_serverUrl;
   uint        m_timeout;
   
   // Market Data for App
   double      m_lastPrice;
   double      m_fastEMA;
   double      m_slowEMA;
   double      m_bbUpper;
   double      m_bbLower;
   double      m_rsi;
   double      m_atr;
   double      m_vwap;
   int         m_spread;
   long        m_tickVolume;
   
public:
   // Constructor
   void CFxScalpKingHTTP()
   {
      m_apiKey = "";
      m_serverUrl = API_BASE_URL;
      m_timeout = 5000; // 5 second timeout
      m_lastPrice = 0.0;
      m_fastEMA = 0.0;
      m_slowEMA = 0.0;
      m_bbUpper = 0.0;
      m_bbLower = 0.0;
      m_rsi = 0.0;
      m_atr = 0.0;
      m_vwap = 0.0;
      m_spread = 0;
      m_tickVolume = 0;
   }
   
   // Set Market Data to send in heartbeat
   void SetMarketData(double price, double fastEMA, double slowEMA, double bbUpper, double bbLower, double rsi = 0.0, double atr = 0.0, double vwap = 0.0, int spread = 0, long tickVolume = 0)
   {
      m_lastPrice = price;
      m_fastEMA = fastEMA;
      m_slowEMA = slowEMA;
      m_bbUpper = bbUpper;
      m_bbLower = bbLower;
      m_rsi = rsi;
      m_atr = atr;
      m_vwap = vwap;
      m_spread = spread;
      m_tickVolume = tickVolume;
   }
   
   // Set API Key
   void SetApiKey(string key)
   {
      m_apiKey = key;
   }
   
   // Set Server URL
   void SetServerUrl(string url)
   {
      m_serverUrl = url;
   }

   //+------------------------------------------------------------------+
   //| VALIDATE LICENSE                                                 |
   //| Returns: true = valid, false = invalid                          |
   //+------------------------------------------------------------------+
   bool ValidateLicense(string &expiry, string &plan)
   {
      if(m_apiKey == "" || StringLen(m_apiKey) < 8)
      {
         Print("❌ FXScalpKing: Empty or invalid API key");
         return false;
      }
      
      // Prepare JSON body
      string json = "{"
         "\"apiKey\":\"" + m_apiKey + "\","
         "\"accountId\":" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) +
         "}";
      
      string headers = "Content-Type: application/json";
      string response;
      int respCode;
      
      Print("🔑 FXScalpKing: Validating license with backend...");
      
      // Make HTTP POST request
      bool success = HttpRequest(
         "POST", 
         m_serverUrl + "/api/ea/validate", 
         headers, 
         json, 
         response, 
         respCode
      );
      
      if(!success || respCode != 200)
      {
         Print("❌ FXScalpKing: License validation failed. Code: ", respCode);
         if(StringLen(response) > 0) Print("Response: ", response);
         return false;
      }
      
      // Parse JSON response (simple string parsing)
      if(StringFind(response, "\"valid\":true") >= 0)
      {
         // Extract expiry date
         int expStart = StringFind(response, "\"expiry\":\"") + 10;
         int expEnd = StringFind(response, "\"", expStart);
         if(expStart > 9)
            expiry = StringSubstr(response, expStart, expEnd - expStart);
         
         // Extract plan type
         int planStart = StringFind(response, "\"plan\":\"") + 8;
         int planEnd = StringFind(response, "\"", planStart);
         if(planStart > 7)
            plan = StringSubstr(response, planStart, planEnd - planStart);
         
         Print("✅ FXScalpKing: License valid! Plan: ", plan, " | Expires: ", expiry);
         return true;
      }
      
      Print("❌ FXScalpKing: Invalid license response");
      return false;
   }

   //+------------------------------------------------------------------+
   //| SEND HEARTBEAT & GET COMMANDS                                    |
   //| Returns: array of pending commands                               |
   //+------------------------------------------------------------------+
   bool SendHeartbeat(string &commands[])
   {
      if(m_apiKey == "")
         return false;
      
      // Build account data JSON
      double balance = AccountInfoDouble(ACCOUNT_BALANCE);
      double equity = AccountInfoDouble(ACCOUNT_EQUITY);
      double profit = AccountInfoDouble(ACCOUNT_PROFIT);
      double margin = AccountInfoDouble(ACCOUNT_MARGIN);
      double freeMargin = AccountInfoDouble(ACCOUNT_MARGIN_FREE);
      
      string json = "{"
         "\"apiKey\":\"" + m_apiKey + "\","
         "\"accountData\":{"
            "\"balance\":" + DoubleToString(balance, 2) + ","
            "\"equity\":" + DoubleToString(equity, 2) + ","
            "\"pnl_today\":" + DoubleToString(profit, 2) + ","
            "\"margin\":" + DoubleToString(margin, 2) + ","
            "\"freeMargin\":" + DoubleToString(freeMargin, 2) + ","
            "\"accountId\":" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) + ","
            "\"eaSymbol\":\"" + _Symbol + "\","
            "\"price\":" + DoubleToString(m_lastPrice, 5) + ","
            "\"fastEMA\":" + DoubleToString(m_fastEMA, 5) + ","
            "\"slowEMA\":" + DoubleToString(m_slowEMA, 5) + ","
            "\"bbUpper\":" + DoubleToString(m_bbUpper, 5) + ","
            "\"bbLower\":" + DoubleToString(m_bbLower, 5) + ","
            "\"rsi\":" + DoubleToString(m_rsi, 5) + ","
            "\"atr\":" + DoubleToString(m_atr, 5) + ","
            "\"vwap\":" + DoubleToString(m_vwap, 5) + ","
            "\"spread\":" + IntegerToString(m_spread) + ","
            "\"tickVolume\":" + IntegerToString(m_tickVolume) +
         "},"
         "\"chart\":{";

      // Helper function to build chart JSON for a specific timeframe
      ENUM_TIMEFRAMES tfs[] = {PERIOD_M1, PERIOD_M5, PERIOD_M15, PERIOD_M30, PERIOD_H1};
      string tfNames[] = {"M1", "M5", "M15", "M30", "H1"};
      
      for(int t = 0; t < ArraySize(tfs); t++)
      {
         if(t > 0) json += ",";
         json += "\"" + tfNames[t] + "\":[";
         
         double open[], high[], low[], close[];
         long tickVol[];
         
         // To properly identify HTF structures, we need more candles. 100 should be safe.
         int numCandles = 100;
         int copied = CopyOpen(_Symbol, tfs[t], 0, numCandles, open);
         int copiedH = CopyHigh(_Symbol, tfs[t], 0, numCandles, high);
         int copiedL = CopyLow(_Symbol, tfs[t], 0, numCandles, low);
         int copiedC = CopyClose(_Symbol, tfs[t], 0, numCandles, close);
         int copiedV = CopyTickVolume(_Symbol, tfs[t], 0, numCandles, tickVol);
         
         int limit = MathMin(copied, MathMin(copiedH, MathMin(copiedL, MathMin(copiedC, copiedV))));
         limit = MathMin(numCandles, limit);
         
         if(limit > 0)
         {
            ArraySetAsSeries(open, true);
            ArraySetAsSeries(high, true);
            ArraySetAsSeries(low, true);
            ArraySetAsSeries(close, true);
            ArraySetAsSeries(tickVol, true);
            
            for(int i = limit - 1; i >= 0; i--)
            {
               if(i < limit - 1) json += ",";
               
               datetime time = iTime(_Symbol, tfs[t], i);
               
               json += "{";
               json += "\"x\":" + IntegerToString(time) + ",";
               json += "\"open\":" + DoubleToString(open[i], 5) + ",";
               json += "\"high\":" + DoubleToString(high[i], 5) + ",";
               json += "\"low\":" + DoubleToString(low[i], 5) + ",";
               json += "\"close\":" + DoubleToString(close[i], 5) + ",";
               json += "\"tick_volume\":" + IntegerToString(tickVol[i]);
               json += "}";
            }
         }
         json += "]";
      }
      
      json += "},"
         "\"positions\":[";
      
      // Add open positions (Fixed position iteration logic)
      bool first = true;
      for(int i = PositionsTotal() - 1; i >= 0; i--)
      {
         ulong ticket = PositionGetTicket(i);
         if(ticket <= 0) continue;
         if(!PositionSelectByTicket(ticket)) continue;
         
         if(PositionGetString(POSITION_SYMBOL) != _Symbol)
            continue;
         if(PositionGetInteger(POSITION_MAGIC) != MagicNumber)
            continue;
            
         if(!first) json += ",";
         first = false;
         
         ENUM_POSITION_TYPE posType = (ENUM_POSITION_TYPE)PositionGetInteger(POSITION_TYPE);
         json += "{";
         json += "\"ticket\":" + IntegerToString(PositionGetInteger(POSITION_TICKET)) + ",";
         json += "\"time\":" + IntegerToString(PositionGetInteger(POSITION_TIME)) + ",";
         json += "\"type\":\"" + (posType == POSITION_TYPE_BUY ? "BUY" : "SELL") + "\",";
         json += "\"symbol\":\"" + PositionGetString(POSITION_SYMBOL) + "\",";
         json += "\"volume\":" + DoubleToString(PositionGetDouble(POSITION_VOLUME), 2) + ",";
         json += "\"price\":" + DoubleToString(PositionGetDouble(POSITION_PRICE_OPEN), 5) + ",";
         json += "\"sl\":" + DoubleToString(PositionGetDouble(POSITION_SL), 5) + ",";
         json += "\"tp\":" + DoubleToString(PositionGetDouble(POSITION_TP), 5) + ",";
         json += "\"profit\":" + DoubleToString(PositionGetDouble(POSITION_PROFIT), 2);
         json += "}";
      }
      
      json += "]}";
      
      string headers = "Content-Type: application/json";
      string response;
      int respCode;
      
      bool success = HttpRequest(
         "POST",
         m_serverUrl + "/api/ea/update",
         headers,
         json,
         response,
         respCode
      );
      
      if(!success || respCode != 200) {
         Print("❌ Update failed. Code: ", respCode);
         return false;
      }
      
      // Parse commands from response
      ArrayResize(commands, 0);
      
      int cmdStart = StringFind(response, "\"commands\":[");
      if(cmdStart < 0)
         return true; // No commands
      
      // Extract commands array
      int arrayStart = cmdStart + 12;
      int arrayEnd = StringFind(response, "]", arrayStart);
      string cmds = StringSubstr(response, arrayStart, arrayEnd - arrayStart);
      if (StringLen(cmds) > 2) Print("Raw commands from backend: ", cmds);
      
      // Simple parsing of command objects (Backend returns objects)
      int pos = 0;
      while(pos < StringLen(cmds))
      {
         int objStart = StringFind(cmds, "{", pos);
         if(objStart < 0) break;
         int objEnd = StringFind(cmds, "}", objStart);
         if(objEnd < 0) break;
         
         string cmdObj = StringSubstr(cmds, objStart, objEnd - objStart + 1);
         
         // Extract action
         int actionStart = StringFind(cmdObj, "\"action\":\"") + 10;
         int actionEnd = StringFind(cmdObj, "\"", actionStart);
         string action = StringSubstr(cmdObj, actionStart, actionEnd - actionStart);
         
         // Extract sl
         int slStart = StringFind(cmdObj, "\"sl\":") + 5;
         int slEnd = StringFind(cmdObj, ",", slStart);
         if(slEnd < 0) slEnd = StringFind(cmdObj, "}", slStart);
         string slStr = (slStart > 4 && slEnd > slStart) ? StringSubstr(cmdObj, slStart, slEnd - slStart) : "0";
         
         // Extract tp
         int tpStart = StringFind(cmdObj, "\"tp\":") + 5;
         int tpEnd = StringFind(cmdObj, ",", tpStart);
         if(tpEnd < 0) tpEnd = StringFind(cmdObj, "}", tpStart);
         string tpStr = (tpStart > 4 && tpEnd > tpStart) ? StringSubstr(cmdObj, tpStart, tpEnd - tpStart) : "0";
         
         // Extract top (for DRAW)
         int topStart = StringFind(cmdObj, "\"top\":") + 6;
         int topEnd = StringFind(cmdObj, ",", topStart);
         if(topEnd < 0) topEnd = StringFind(cmdObj, "}", topStart);
         string topStr = (topStart > 5 && topEnd > topStart) ? StringSubstr(cmdObj, topStart, topEnd - topStart) : "0";
         
         // Extract bottom (for DRAW)
         int botStart = StringFind(cmdObj, "\"bottom\":") + 9;
         int botEnd = StringFind(cmdObj, ",", botStart);
         if(botEnd < 0) botEnd = StringFind(cmdObj, "}", botStart);
         string botStr = (botStart > 8 && botEnd > botStart) ? StringSubstr(cmdObj, botStart, botEnd - botStart) : "0";
         
         // Extract zoneType (for DRAW)
         int typeStart = StringFind(cmdObj, "\"zoneType\":\"") + 12;
         int typeEnd = StringFind(cmdObj, "\"", typeStart);
         string typeStr = (typeStart > 11 && typeEnd > typeStart) ? StringSubstr(cmdObj, typeStart, typeEnd - typeStart) : "";
         
         // Extract time (for DRAW)
         int timeStart = StringFind(cmdObj, "\"time\":") + 7;
         int timeEnd = StringFind(cmdObj, ",", timeStart);
         if(timeEnd < 0) timeEnd = StringFind(cmdObj, "}", timeStart);
         string timeStr = (timeStart > 6 && timeEnd > timeStart) ? StringSubstr(cmdObj, timeStart, timeEnd - timeStart) : "0";
         
         // Add to commands array (Format: ACTION|SL|TP|TOP|BOTTOM|TYPE|TIME)
         int idx = ArraySize(commands);
         ArrayResize(commands, idx + 1);
         if(StringFind(action, "DRAW_") == 0) {
            commands[idx] = action + "|" + topStr + "|" + botStr + "|" + typeStr + "|" + timeStr;
            Print("Parsed drawing command: ", commands[idx]);
         } else {
            commands[idx] = action + "|" + slStr + "|" + tpStr;
            Print("Parsed trade command: ", commands[idx]);
         }
         
         pos = objEnd + 1;
      }
      
      return true;
   }

   //+------------------------------------------------------------------+
   //| NOTIFY TRADE EXECUTED                                            |
   //+------------------------------------------------------------------+
   bool NotifyTradeExecuted(ulong ticket, string type, double volume, 
                            double price, double sl, double tp, double profit)
   {
      if(m_apiKey == "")
         return false;
      
      string json = "{"
         "\"apiKey\":\"" + m_apiKey + "\","
         "\"trade\":{"
            "\"ticket\":" + IntegerToString(ticket) + ","
            "\"type\":\"" + type + "\","
            "\"symbol\":\"" + _Symbol + "\","
            "\"lots\":" + DoubleToString(volume, 2) + ","
            "\"price\":" + DoubleToString(price, 5) + ","
            "\"sl\":" + DoubleToString(sl, 5) + ","
            "\"tp\":" + DoubleToString(tp, 5) + ","
            "\"profit\":" + DoubleToString(profit, 2) +
         "}}";
      
      string headers = "Content-Type: application/json";
      string response;
      int respCode;
      
      bool success = HttpRequest(
         "POST",
         m_serverUrl + "/api/ea/trade-executed",
         headers,
         json,
         response,
         respCode
      );
      
      return success && respCode == 200;
   }
   
   //+------------------------------------------------------------------+
   //| HTTP REQUEST HELPER                                              |
   //+------------------------------------------------------------------+
   bool HttpRequest(string method, string url, string headers, string body, string &result, int &respCode)
   {
      char post[], resultData[];
      string resultHeaders;
      
      // Ensure headers end with \r\n for WebRequest compatibility
      if(StringFind(headers, "\r\n") < 0)
         headers = headers + "\r\n";
      
      if(body != "")
      {
         // CRITICAL: We must remove the terminal \0 byte appended by StringToCharArray
         // Node.js body-parser will reject JSON strings containing a null byte with 400 Bad Request
         int copied = StringToCharArray(body, post, 0, WHOLE_ARRAY, CP_UTF8);
         if(copied > 0)
            ArrayResize(post, copied - 1); // Remove the terminal \0 byte
      }
         
      ResetLastError();
      int res = WebRequest(method, url, headers, m_timeout, post, resultData, resultHeaders);
      
      respCode = res;
      if(res == -1)
      {
         Print("❌ WebRequest error: ", GetLastError(), " on URL: ", url);
         return false;
      }
      
      result = CharArrayToString(resultData, 0, WHOLE_ARRAY, CP_UTF8);
      return true;
   }
};

//+------------------------------------------------------------------+
//| GLOBAL INSTANCE                                                  |
//+------------------------------------------------------------------+
CFxScalpKingHTTP FxScalpKing;

#endif // FXSCALPKING_HTTP_MQH
//+------------------------------------------------------------------+
