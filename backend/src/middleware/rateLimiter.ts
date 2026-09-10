// Rate limiting policies for LiquiBot's public HTTP endpoints.
import rateLimit from 'express-rate-limit';
import type { Request } from 'express';

// 429 handler adds Retry-After header so EA's libcurl + ScalpKing respect it.
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

// IPv4 -> use verbatim. IPv6 -> collapse to the /64 subnet so one customer
// behind an IPv6 dynamic range (common on 5G/Starlink) lands in one bucket.
// Using our own helper (not ERL's ipKeyGenerator) avoids the module-load
// ValidationError ERR_ERL_KEY_GEN_IPV6 that fires when a custom keyGenerator
// calls req.ip — newer ERL versions validate this strictly and crash the pod
// at require() time even when the logic is functionally correct.
function safeIpFallback(rawIp: string | undefined): string {
  const ip = String(rawIp || '0.0.0.0').trim();
  if (!ip) return 'ip:unknown';
  // IPv6 (contains colon) — take first 4 hextets = /64 subnet.
  if (ip.includes(':')) {
    const bracketed = ip.startsWith('[') ? ip.slice(1, -1) : ip;
    const withoutZone = bracketed.split('%')[0];
    const parts = withoutZone.split(':').filter((p) => p.length || /^::/.test(bracketed));
    return `ip6:${parts.slice(0, 4).join(':')}`;
  }
  return `ip:${ip}`;
}

// Key buckets by x-api-key (when present) so multiple EAs on the same home NAT
// don't share an IP bucket. Falls back to our own IPv6-subnet-safe IP fallback.
function keyByApiKeyOrIp(req: Request): string {
  const apiKey = req.header('x-api-key');
  if (apiKey && apiKey.length >= 8) return `k:${apiKey.slice(0, 16)}`;
  return safeIpFallback(req.ip || req.socket.remoteAddress || undefined);
}

// Disable ERL's strict "keyGeneratorIpFallback" check globally — we handle
// IPv6 bucketing ourselves above, so the validator has nothing to add and
// historically has caused Render pod crash at require() time when ERL and our
// code disagree on whether the helper is being called correctly.
const noIpValidate = { keyGeneratorIpFallback: false } as const;

export const eaValidateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByApiKeyOrIp,
  validate: noIpValidate,
  handler: jsonRateLimitHandler(60),
});

export const userActionLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  validate: noIpValidate,
  handler: jsonRateLimitHandler(30),
});

// EA /api/ea/update + /api/ea/execution-report — 6000 per 10 min = 10/sec per
// EA. Window is 10 minutes so Cloudflare doesn't score 60s-window bursts.
export const eaPollingLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 6000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByApiKeyOrIp,
  validate: noIpValidate,
  handler: jsonRateLimitHandler(120),
});

// EA /api/ea/commands — compat endpoint for older EA builds that still
// call this in a tight loop (ScalpKing EA v3 has NOT been updated yet to
// read commands inline from the /update response body). Until we rebuild
// the EA and drop this compat poll entirely, keep cap equal to the main
// update limiter (6000/10min ~10/sec); the earlier 600 cap caused random
// 429s on the EA Expert terminal whenever commands poll ran faster (which
// is exactly what we saw after commit f2077ce1c deployed).
export const eaCommandsLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 6000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByApiKeyOrIp,
  validate: noIpValidate,
  handler: jsonRateLimitHandler(30),
});
