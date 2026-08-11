//+------------------------------------------------------------------+
//|                                        FxScalpKing_HTTP.mqh       |
//|                                      FxScalpKing Integration      |
//|                         For use with FxScalpKing EA v3.0+        |
//+------------------------------------------------------------------+

#ifndef FXSCALPKING_HTTP_MQH
#define FXSCALPKING_HTTP_MQH

// --- SERVER URL TOGGLE ---
// [LOCAL DEV]  Use:  "http://localhost:5000"     (backend running on your PC, EA on same PC)
// [LOCAL LAN]  Use:  "http://192.168.X.X:5000"  (backend on same LAN, different PC)
// [CLOUD]      Use:  "https://<your-app>.onrender.com"  (backend deployed online)
// This define is the FALLBACK only — the EA's ServerURL INPUT overrides it in OnInit().
#define API_BASE_URL "http://localhost:5000"

class CFxScalpKingHTTP
{
private:
   string      m_apiKey;
   string      m_serverUrl;
   uint        m_timeout;

   // Backend requireEaKey() reads the x-api-key header (NOT the JSON body).
   string AuthHeaders()
   {
      return "Content-Type: application/json\r\nx-api-key: " + m_apiKey + "\r\n";
   }

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

   // Report Execution Result
   bool ReportExecution(string jsonPayload, string &response)
   {
      int code;
      return PostRequest("/api/ea/execution-report", jsonPayload, response, code);
   }

private:
   bool PostRequest(string endpoint, string body, string &response, int &code)
   {
      char post[], result[];
      string headers = AuthHeaders();
      StringToCharArray(body, post, 0, StringLen(body), CP_UTF8);

      ResetLastError();
      code = WebRequest("POST", m_serverUrl + endpoint, headers, m_timeout, post, result, headers);

      if(code == -1) {
         Print("❌ WebRequest Error: ", GetLastError());
         return false;
      }

      if(code == 401) {
         Print("❌ Unauthorized (401) — x-api-key must match backend EA_API_KEY exactly");
      }

      response = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
      return true;
   }

   bool GetRequest(string endpoint, string &response, int &code)
   {
      char post[], result[];
      string headers = AuthHeaders();

      ResetLastError();
      code = WebRequest("GET", m_serverUrl + endpoint, headers, m_timeout, post, result, headers);

      if(code == -1) return false;

      if(code == 401) {
         Print("❌ Unauthorized (401) on GET ", endpoint, " — check x-api-key / EA_API_KEY");
      }

      response = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
      return true;
   }
};

CFxScalpKingHTTP FxScalpKing;

#endif
