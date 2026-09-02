// Rate limiting policies for LiquiBot's public HTTP endpoints.
import rateLimit from 'express-rate-limit';
import type { Request } from 'express';

// 429 handler now adds Retry-After header (integer seconds) so MQL4's libcurl
// and ScalpKing EA see a proper HTTP 429 + Retry-After instead of a Cloudflare
// HTML challenge (HTML response is what caused the "random" dead pattern where
// retries immediately re-issue). Also the response body is consistent JSON so
// the EA's JSON parser doesn't choke on DOCTYPE.
function jsonRateLimitHandler(waitSeconds: number = 60) {
  return (req: Request, res: any) => {
    res.setHeader('Retry-After', String(waitSeconds));
    res.status(429).json({
      success: false,
      error: `Too many requests, please retry in ${waitSeconds}s.`,
      retryAfterSeconds: waitSeconds,
    });
  };
}

// Key rate limiter buckets by the EA's x-api-key header (when present) so EAs
// behind the same home/office NAT (shared public IP) each get their own token
// bucket instead of competing for the same IP-level cap. Defaults to req.ip
// when no header (mobile app / dashboard calls), preserving behavior for users.
function keyByApiKeyOrIp(req: Request): string {
  const apiKey = req.header('x-api-key');
  if (apiKey && apiKey.length >= 8) return `k:${apiKey.slice(0, 16)}`;
  return `ip:${req.ip || req.socket.remoteAddress || 'unknown'}`;
}

// EA license validate: cap brute-force guessing (30/min) but tolerate Render
// free-tier cold starts which can take ~40s + ~10 retries during boot.
export const eaValidateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByApiKeyOrIp,
  handler: jsonRateLimitHandler(60),
});

// Moderate: user-triggered actions (manual orders, config changes, Train taps).
export const userActionLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonRateLimitHandler(30),
});

// EA /api/ea/update + /api/ea/execution-report — 6000 per 10 min = 10/sec per
// EA. This is deliberately generous (1 EA on M5 heartbeats ~2-5s = 12-30/min).
// Window is 10 minutes so Cloudflare doesn't see short 60s bucket bursts as a
// spike. Cloudflare triggers challenge pages at ~120+ requests/min from one
// IP/user-agent, so keeping per-EA sustained rate well under + keying by API
// key (not IP) is what eliminates the "random 429 HTML" pattern.
export const eaPollingLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 6000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByApiKeyOrIp,
  handler: jsonRateLimitHandler(120),
});

// EA /api/ea/commands — /update response ALSO returns pending commands (since
// this commit). This endpoint is kept ONLY for backwards compat with older EAs
// that still poll /commands separately. Hard-cap to encourage migration: 600
// per 10 min = 1/sec absolute MAX; modern EAs should rely on /update returning
// commands[] and stop calling /commands entirely.
export const eaCommandsLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByApiKeyOrIp,
  handler: jsonRateLimitHandler(30),
});
