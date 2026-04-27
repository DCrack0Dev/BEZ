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
   
public:
   // Constructor
   void CFxScalpKingHTTP()
   {
      m_apiKey = "";
      m_serverUrl = API_BASE_URL;
      m_timeout = 5000; // 5 second timeout
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
            "\"accountId\":" + IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN)) +
         "},"
         "\"positions\":[";
      
      // Add open positions
      bool first = true;
      for(int i = PositionsTotal() - 1; i >= 0; i--)
      {
         if(!PositionSelect(_Symbol))
            continue;
         if(PositionGetInteger(POSITION_MAGIC) != MagicNumber)
            continue;
            
         if(!first) json += ",";
         first = false;
         
         ENUM_POSITION_TYPE posType = PositionGetInteger(POSITION_TYPE);
         json += "{";
         json += "\"ticket\":" + IntegerToString(PositionGetInteger(POSITION_TICKET)) + ",";
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
      
      if(!success || respCode != 200)
         return false;
      
      // Parse commands from response
      ArrayResize(commands, 0);
      
      int cmdStart = StringFind(response, "\"commands\":[");
      if(cmdStart < 0)
         return true; // No commands
      
      // Extract commands array
      int arrayStart = cmdStart + 12;
      int arrayEnd = StringFind(response, "]", arrayStart);
      string cmds = StringSubstr(response, arrayStart, arrayEnd - arrayStart);
      
      // Simple parsing of command objects
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
         
         // Add to commands array
         int idx = ArraySize(commands);
         ArrayResize(commands, idx + 1);
         commands[idx] = action;
         
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
            "\"volume\":" + DoubleToString(volume, 2) + ","
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
};

//+------------------------------------------------------------------+
//| GLOBAL INSTANCE                                                  |
//+------------------------------------------------------------------+
CFxScalpKingHTTP FxScalpKing;

#endif // FXSCALPKING_HTTP_MQH
//+------------------------------------------------------------------+
