//+------------------------------------------------------------------+
//|                                        FxScalpKing_HTTP.mqh       |
//|                                      FxScalpKing Integration      |
//|                         For use with FxScalpKing EA v2.1+        |
//+------------------------------------------------------------------+

#ifndef FXSCALPKING_HTTP_MQH
#define FXSCALPKING_HTTP_MQH

#define API_BASE_URL "https://liquibot-back.onrender.com"

class CFxScalpKingHTTP
{
private:
   string      m_apiKey;
   string      m_serverUrl;
   uint        m_timeout;
   
public:
   void CFxScalpKingHTTP()
   {
      m_apiKey = "";
      m_serverUrl = API_BASE_URL;
      m_timeout = 10000; // 10s timeout
   }
   
   void SetApiKey(string key) { m_apiKey = key; }
   void SetServerUrl(string url) { 
      m_serverUrl = url; 
      if(StringSubstr(m_serverUrl, StringLen(m_serverUrl)-1) == "/") 
         m_serverUrl = StringSubstr(m_serverUrl, 0, StringLen(m_serverUrl)-1);
   }

   // Robust validation with better logging
   bool ValidateLicense(string &expiry, string &plan)
   {
      if(m_apiKey == "") { Print("❌ API Key is empty"); return false; }
      
      string json = "{\"apiKey\":\"" + m_apiKey + "\"}";
      string response;
      int code;
      
      Print("📡 Connecting to: ", m_serverUrl, "/api/ea/validate");
      
      if(!PostRequest("/api/ea/validate", json, response, code)) return false;
      
      if(code != 200) {
         Print("❌ Validation failed. HTTP Code: ", code, " | Resp: ", response);
         return false;
      }
      
      if(StringFind(response, "\"valid\":true") >= 0) {
         Print("✅ License Validated Successfully");
         return true;
      }
      
      Print("❌ License Invalid: ", response);
      return false;
   }

   // Simplified Heartbeat
   bool SendHeartbeat(string jsonPayload, string &response)
   {
      int code;
      return PostRequest("/api/ea/update", jsonPayload, response, code);
   }

   // Simplified Command Polling
   string GetCommands()
   {
      string response;
      int code;
      if(GetRequest("/api/ea/commands", response, code)) return response;
      return "";
   }

private:
   bool PostRequest(string endpoint, string body, string &response, int &code)
   {
      char post[], result[];
      string headers = "Content-Type: application/json\r\n";
      StringToCharArray(body, post, 0, StringLen(body), CP_UTF8);
      
      ResetLastError();
      code = WebRequest("POST", m_serverUrl + endpoint, headers, m_timeout, post, result, headers);
      
      if(code == -1) {
         Print("❌ WebRequest Error: ", GetLastError());
         return false;
      }
      
      response = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
      return true;
   }

   bool GetRequest(string endpoint, string &response, int &code)
   {
      char post[], result[];
      string headers = "Content-Type: application/json\r\n";
      
      ResetLastError();
      code = WebRequest("GET", m_serverUrl + endpoint, headers, m_timeout, post, result, headers);
      
      if(code == -1) return false;
      
      response = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
      return true;
   }
};

CFxScalpKingHTTP FxScalpKing;

#endif
