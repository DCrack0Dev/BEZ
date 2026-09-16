//+------------------------------------------------------------------+
//|                                        FxScalpKing_HTTP.mqh       |
//|                                      FxScalpKing Integration      |
//|                         For use with FxScalpKing EA v3.0+        |
//|  v3.1: adds explicit backoff, connection states, transition logs |
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

enum EConnState
{
   CONN_CONNECTED   = 0,
   CONN_DEGRADED    = 1,
   CONN_DISCONNECTED= 2,
   CONN_AUTH_FAILURE= 3,
   CONN_RATE_LIMITED= 4,
   CONN_SERVER_ERROR= 5,
   CONN_INIT        = 6,
};

class CFxScalpKingHTTP
{
private:
   string      m_apiKey;
   string      m_serverUrl;
   uint        m_timeout;
   int         m_lastHttpCode;
   int         m_lastError;

   // --- Backoff (exponential + jitter, bounded) ---
   int         m_backoffLevel;    // 0 = reset, otherwise 1..BACKOFF_MAX_LEVEL
   long        m_backoffUntilMs;  // TimeCurrent()*1000 deadline
   int         m_consec401;       // consecutive 401 → AUTH_FAILURE after N
   int         m_consecNetFail;   // consecutive code==-1 → DISCONNECTED after N

   // --- Connection state machine (transition-only logging) ---
   EConnState  m_state;
   string      m_lastDetail;

   #define BACKOFF_BASE_MS    2000
   #define BACKOFF_MAX_MS     120000
   #define BACKOFF_MAX_LEVEL  8
   #define BACKOFF_JITTER_PCT 50    // ±50% jitter
   #define AUTH_FAIL_THRESH   3
   #define DISCONNECT_THRESH  3

   void SetState(EConnState next, string detail)
   {
      if(next == m_state)
         return;
      string oldText = ConnStateText(m_state);
      m_state = next;
      m_lastDetail = detail;
      Print("[CONNECTION] ", oldText, " → ", ConnStateText(m_state),
            (detail != "" ? " — " + detail : ""));
   }

   string ConnStateText(EConnState s)
   {
      switch(s)
      {
         case CONN_CONNECTED:    return "CONNECTED";
         case CONN_DEGRADED:     return "DEGRADED";
         case CONN_DISCONNECTED: return "DISCONNECTED";
         case CONN_AUTH_FAILURE: return "AUTH_FAILURE";
         case CONN_RATE_LIMITED: return "RATE_LIMITED";
         case CONN_SERVER_ERROR: return "SERVER_ERROR";
         case CONN_INIT:         return "INIT";
      }
      return "UNKNOWN";
   }

   long NowMs() { return (long)TimeCurrent() * 1000; }

   // Apply jitter = wait * (100 ± JITTER)% / 100
   long ApplyJitter(long waitMs)
   {
      if(waitMs <= 0) return 0;
      int half = (int)MathMin(50, MathMax(0, BACKOFF_JITTER_PCT));
      // MathRand: 0..32767 → map to -half..+half percent
      int rPct = (int)((long)MathRand() * (2L*half) / 32768L) - half;
      long delta = (waitMs * (long)rPct) / 100L;
      return MathMax(1L, waitMs + delta);
   }

   void ApplyBackoff()
   {
      if(m_backoffLevel < 0) m_backoffLevel = 0;
      if(m_backoffLevel > BACKOFF_MAX_LEVEL) m_backoffLevel = BACKOFF_MAX_LEVEL;
      long baseWait;
      if(m_backoffLevel <= 1)
         baseWait = BACKOFF_BASE_MS;
      else
         baseWait = (long)BACKOFF_BASE_MS * (1L << (m_backoffLevel - 1));
      if(baseWait > BACKOFF_MAX_MS) baseWait = BACKOFF_MAX_MS;
      long wait = ApplyJitter(baseWait);
      if(wait < 1000L) wait = 1000L;
      if(wait > BACKOFF_MAX_MS) wait = BACKOFF_MAX_MS;
      m_backoffUntilMs = NowMs() + wait;
   }

   void ResetBackoff()
   {
      m_backoffLevel = 0;
      m_backoffUntilMs = 0L;
   }

   void IncrementBackoff()
   {
      if(m_backoffLevel < BACKOFF_MAX_LEVEL)
         m_backoffLevel++;
      ApplyBackoff();
   }

   // Backend requireEaKey() reads the x-api-key header (NOT the JSON body).
   string AuthHeaders()
   {
      return "Content-Type: application/json\r\nx-api-key: " + m_apiKey + "\r\n";
   }

   void ExplainWebRequestFailure(string method, string endpoint, int code, int err)
   {
      if(code == -1)
      {
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
         Print("⚠️ Rate limited (429) on ", method, " ", endpoint, " — exponential backoff active");
      else if(code >= 500)
         Print("❌ Server error (", code, ") on ", method, " ", endpoint, " — backoff active");
      else if(code >= 400)
         Print("❌ HTTP ", code, " on ", method, " ", endpoint);
   }

   // Called after every HTTP attempt. Drives state machine + backoff.
   void RecordHttpOutcome(int code, int err, string method, string endpoint)
   {
      // 2xx success
      if(code >= 200 && code < 300)
      {
         ResetBackoff();
         m_consec401 = 0;
         m_consecNetFail = 0;
         SetState(CONN_CONNECTED, method + " " + endpoint);
         return;
      }
      // Network failure
      if(code == -1)
      {
         IncrementBackoff();
         m_consecNetFail++;
         if(m_consecNetFail >= DISCONNECT_THRESH)
            SetState(CONN_DISCONNECTED, "netfail x" + IntegerToString(m_consecNetFail));
         else
            SetState(CONN_DEGRADED, "netfail x" + IntegerToString(m_consecNetFail));
         return;
      }
      // 429 (may be Express JSON 429 or Cloudflare HTML 429 "Just a moment...")
      if(code == 429)
      {
         IncrementBackoff();
         m_consecNetFail = 0;
         SetState(CONN_RATE_LIMITED, "retry in " + IntegerToString((int)((m_backoffUntilMs - NowMs())/1000L)) + "s");
         return;
      }
      // 5xx
      if(code >= 500)
      {
         IncrementBackoff();
         m_consecNetFail = 0;
         SetState(CONN_SERVER_ERROR, "HTTP " + IntegerToString(code));
         return;
      }
      // 401
      if(code == 401)
      {
         // Do NOT hammer back; 401s usually aren't transient. Still backoff gently.
         if(m_backoffLevel < 2) { m_backoffLevel = 2; ApplyBackoff(); }
         m_consec401++;
         if(m_consec401 >= AUTH_FAIL_THRESH)
            SetState(CONN_AUTH_FAILURE, "401 x" + IntegerToString(m_consec401));
         else
            SetState(CONN_DEGRADED, "401 x" + IntegerToString(m_consec401));
         return;
      }
      // Other 4xx (validation etc.) — not rate/network related, no backoff growth
      SetState(CONN_DEGRADED, "HTTP " + IntegerToString(code));
   }

public:
   void CFxScalpKingHTTP()
   {
      m_apiKey = "";
      m_serverUrl = API_BASE_URL;
      m_timeout = 60000;
      m_lastHttpCode = 0;
      m_lastError = 0;
      m_backoffLevel = 0;
      m_backoffUntilMs = 0L;
      m_consec401 = 0;
      m_consecNetFail = 0;
      m_state = CONN_INIT;
      m_lastDetail = "";
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

   // Backoff gate — call this before every outbound EA HTTP action.
   bool BackoffDeadlineMet()
   {
      if(m_backoffUntilMs == 0L) return true;
      return NowMs() >= m_backoffUntilMs;
   }

   // Milliseconds until the backoff window ends (0 if none).
   long BackoffRemainingMs()
   {
      if(m_backoffUntilMs == 0L) return 0L;
      long rem = m_backoffUntilMs - NowMs();
      return rem < 0L ? 0L : rem;
   }

   int  BackoffLevel() { return m_backoffLevel; }

   // Connection state
   EConnState GetConnState() { return m_state; }
   string GetConnStateText() { return ConnStateText(m_state); }
   string GetLastConnDetail() { return m_lastDetail; }

   // Force a reset (e.g. after user changes ApiKey input)
   void ResetConnection()
   {
      ResetBackoff();
      m_consec401 = 0;
      m_consecNetFail = 0;
      m_state = CONN_INIT;
      m_lastDetail = "reset";
   }

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
            // Use backoff if the last attempt pushed a backoff deadline.
            long rem = BackoffRemainingMs();
            if(rem <= 0L) rem = (long)sleepMs;
            // Render cold start: wait up to sleepMs first, then cycle.
            long waitMs = MathMax((long)sleepMs, rem);
            Print("⏳ Waiting ", IntegerToString((int)(waitMs/1000L)),
                  "s before retry (Render free tier may be waking)…");
            Sleep((int)MathMin(waitMs, 60000L));
         }
      }
      return false;
   }

   bool SendHeartbeat(string jsonPayload, string &response)
   {
      int code;
      bool ok = PostRequest("/api/ea/update", jsonPayload, response, code);
      if(!ok) return false;
      if(code < 200 || code >= 300)
      {
         // Print short summary (transition logging already emitted by RecordHttpOutcome)
         if(code == 429 || code >= 500 || code == 401)
         {
            // Detailed explain already printed — avoid double-log spam.
         }
         else
         {
            Print("❌ Heartbeat HTTP ", code, " · ", StringSubstr(response, 0, 160));
         }
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

   // Diagnostic helper — safe, doesn't leak key. Returns sha256 first 8 hex chars
   // locally computed on the EA's configured key so user can compare vs. server
   // GET /api/ea/diag fingerprintSha256First8 (requires auth, returns server side).
   // Not a true crypto hash — MQL5 stdlib lacks SHA-256, use a lightweight 64-bit
   // FNV-1a fingerprint (collisions fine for matching same-string inputs manually).
   string LocalKeyFingerprint8()
   {
      if(m_apiKey == "") return "00000000";
      ulong hash = 14695981039346656037ULL;
      int len = StringLen(m_apiKey);
      for(int i = 0; i < len; i++)
      {
         uchar b = (uchar)StringGetCharacter(m_apiKey, i);
         hash ^= (ulong)b;
         hash *= 1099511628211ULL;
      }
      // Upper 8 hex digits of the 64-bit FNV-1a hash
      string s = "";
      ulong v = hash >> 32;
      for(int k = 7; k >= 0; k--)
      {
         int nib = (int)((v >> (k*4)) & 0xF);
         s += (nib < 10 ? CharToString((char)('0'+nib)) : CharToString((char)('a'+(nib-10))));
      }
      return s;
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
      int n = StringToCharArray(body, post, 0, WHOLE_ARRAY, CP_UTF8);
      if(n > 0) ArrayResize(post, n - 1);

      ResetLastError();
      code = WebRequest("POST", m_serverUrl + endpoint, headers, m_timeout, post, result, headers);
      m_lastHttpCode = code;
      m_lastError = GetLastError();
      RecordHttpOutcome(code, m_lastError, "POST", endpoint);

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
      RecordHttpOutcome(code, m_lastError, "GET", endpoint);

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
