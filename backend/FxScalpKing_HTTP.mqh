//+------------------------------------------------------------------+
//|                                        FxScalpKing_HTTP.mqh       |
//|                                      FxScalpKing Integration      |
//|                         For use with FxScalpKing EA v3.0+        |
//+------------------------------------------------------------------+

#ifndef FXSCALPKING_HTTP_MQH
#define FXSCALPKING_HTTP_MQH

// --- SERVER URL TOGGLE ---
// [CLOUD]      Use:  "https://liquibot-back.onrender.com"  (production default)
// [LOCAL DEV]  Use:  "http://localhost:5000"              (backend on same PC as MT5)
// [LOCAL LAN]  Use:  "http://192.168.X.X:5000"           (backend on another LAN PC)
// This define is the FALLBACK only — the EA's ServerURL INPUT overrides it in OnInit().
// Also allowlist the URL in MT5: Tools → Options → Expert Advisors → Allow WebRequest.
#define API_BASE_URL "https://liquibot-back.onrender.com"

class CFxScalpKingHTTP
{
private:
   string      m_apiKey;
   string      m_serverUrl;
   uint        m_timeout;
   int         m_lastHttpCode;
   int         m_lastError;

   // Backend requireEaKey() reads the x-api-key header (NOT the JSON body).
   string AuthHeaders()
   {
      return "Content-Type: application/json\r\nx-api-key: " + m_apiKey + "\r\n";
   }

   void ExplainWebRequestFailure(string method, string endpoint, int code, int err)
   {
      if(code == -1)
      {
         // 4060 = URL not in allowed list; 5203 = HTTP timeout / no connect
         if(err == 4060)
            Print("❌ WebRequest ", method, " ", endpoint,
                  " blocked (err 4060). Add URL to Tools→Options→Expert Advisors→Allow WebRequest: ",
                  m_serverUrl);
         else if(err == 5203 || err == 5200)
            Print("❌ WebRequest ", method, " ", endpoint,
                  " timeout/connect fail (err ", err,
                  "). Free Render cold start can take 50s+ — EA will retry.");
         else
            Print("❌ WebRequest ", method, " ", endpoint, " failed. code=-1 err=", err);
         return;
      }
      if(code == 401)
         Print("❌ Unauthorized (401) on ", method, " ", endpoint,
               " — x-api-key must match Render EA_API_KEY exactly");
      else if(code == 429)
         Print("⚠️ Rate limited (429) on ", method, " ", endpoint, " — backing off");
      else if(code >= 400)
         Print("❌ HTTP ", code, " on ", method, " ", endpoint);
   }

public:
   void CFxScalpKingHTTP()
   {
      m_apiKey = "";
      m_serverUrl = API_BASE_URL;
      // Free Render cold starts often exceed 30s; keep this above wake time.
      m_timeout = 60000;
      m_lastHttpCode = 0;
      m_lastError = 0;
   }

   void SetApiKey(string key) { m_apiKey = key; }
   void SetTimeoutMs(uint ms) { if(ms >= 5000) m_timeout = ms; }
   int  LastHttpCode() { return m_lastHttpCode; }
   int  LastError() { return m_lastError; }

   void SetServerUrl(string url) {
      m_serverUrl = url;
      if(StringSubstr(m_serverUrl, StringLen(m_serverUrl)-1) == "/")
         m_serverUrl = StringSubstr(m_serverUrl, 0, StringLen(m_serverUrl)-1);
   }

   string ServerUrl() { return m_serverUrl; }

   // Robust validation with better logging
   bool ValidateLicense(string &expiry, string &plan)
   {
      if(m_apiKey == "") { Print("❌ API Key is empty"); return false; }

      string json = "{\"apiKey\":\"" + m_apiKey + "\"}";
      string response;
      int code;

      Print("📡 Connecting to: ", m_serverUrl, "/api/ea/validate (timeout ",
            IntegerToString((int)m_timeout), "ms)");

      if(!PostRequest("/api/ea/validate", json, response, code)) return false;

      if(code != 200) {
         Print("❌ Validation failed. HTTP Code: ", code, " | Resp: ",
               StringSubstr(response, 0, 200));
         return false;
      }

      if(StringFind(response, "\"valid\":true") >= 0) {
         Print("✅ License Validated Successfully");
         // Best-effort parse (optional fields)
         expiry = JsonPeekString(response, "expiry", expiry);
         plan = JsonPeekString(response, "plan", plan);
         return true;
      }

      Print("❌ License Invalid: ", StringSubstr(response, 0, 200));
      return false;
   }

   // Retry wrapper for cold starts / transient network
   bool ValidateLicenseWithRetries(string &expiry, string &plan, int maxAttempts, int sleepMs)
   {
      if(maxAttempts < 1) maxAttempts = 1;
      if(sleepMs < 1000) sleepMs = 1000;
      for(int attempt = 1; attempt <= maxAttempts; attempt++)
      {
         Print("🔁 License attempt ", attempt, "/", maxAttempts);
         if(ValidateLicense(expiry, plan)) return true;
         if(attempt < maxAttempts)
         {
            Print("⏳ Waiting ", sleepMs, "ms before retry (Render free tier may be waking)…");
            Sleep(sleepMs);
         }
      }
      return false;
   }

   bool SendHeartbeat(string jsonPayload, string &response)
   {
      int code;
      bool ok = PostRequest("/api/ea/update", jsonPayload, response, code);
      if(!ok) return false;
      // Treat non-2xx as failure so EA Comment / counters stay accurate
      if(code < 200 || code >= 300)
      {
         Print("❌ Heartbeat HTTP ", code, " · ", StringSubstr(response, 0, 160));
         return false;
      }
      return true;
   }

   string GetCommands()
   {
      string response;
      int code;
      if(GetRequest("/api/ea/commands", response, code) && code >= 200 && code < 300)
         return response;
      return "";
   }

   bool ReportExecution(string jsonPayload, string &response)
   {
      int code;
      bool ok = PostRequest("/api/ea/execution-report", jsonPayload, response, code);
      return ok && code >= 200 && code < 300;
   }

private:
   string JsonPeekString(string json, string key, string fallback)
   {
      string needle = "\"" + key + "\":\"";
      int pos = StringFind(json, needle);
      if(pos < 0) return fallback;
      int start = pos + StringLen(needle);
      int end = StringFind(json, "\"", start);
      if(end < 0) return fallback;
      return StringSubstr(json, start, end - start);
   }

   bool PostRequest(string endpoint, string body, string &response, int &code)
   {
      char post[], result[];
      string headers = AuthHeaders();
      // StringToCharArray appends a trailing '\0' — WebRequest must NOT send it
      // or Express body-parser returns HTML 400 Bad Request.
      int n = StringToCharArray(body, post, 0, WHOLE_ARRAY, CP_UTF8);
      if(n > 0) ArrayResize(post, n - 1);

      ResetLastError();
      code = WebRequest("POST", m_serverUrl + endpoint, headers, m_timeout, post, result, headers);
      m_lastHttpCode = code;
      m_lastError = GetLastError();

      if(code == -1) {
         ExplainWebRequestFailure("POST", endpoint, code, m_lastError);
         return false;
      }

      if(code == 401 || code == 429 || code >= 400)
         ExplainWebRequestFailure("POST", endpoint, code, m_lastError);

      response = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
      return true;
   }

   bool GetRequest(string endpoint, string &response, int &code)
   {
      char post[], result[];
      string headers = AuthHeaders();

      ResetLastError();
      code = WebRequest("GET", m_serverUrl + endpoint, headers, m_timeout, post, result, headers);
      m_lastHttpCode = code;
      m_lastError = GetLastError();

      if(code == -1) {
         ExplainWebRequestFailure("GET", endpoint, code, m_lastError);
         return false;
      }

      if(code == 401 || code == 429 || code >= 400)
         ExplainWebRequestFailure("GET", endpoint, code, m_lastError);

      response = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
      return true;
   }
};

CFxScalpKingHTTP FxScalpKing;

#endif
