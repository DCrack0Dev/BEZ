// Rate limiting policies for LiquiBot's public HTTP endpoints.
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
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

// Key buckets by x-api-key (when present) so multiple EAs on the same home NAT
// don't share an IP bucket. Falls back to library ipKeyGenerator(req.ip) for
// IPv6 subnet-safe dedupe (passing raw req.ip here trips ERR_ERL_KEY_GEN_IPV6).
function keyByApiKeyOrIp(req: Request): string {
  const apiKey = req.header('x-api-key');
  if (apiKey && apiKey.length >= 8) return `k:${apiKey.slice(0, 16)}`;
  return `ip:${ipKeyGenerator(req.ip || req.socket.remoteAddress || '0.0.0.0')}`;
}

export const eaValidateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByApiKeyOrIp,
  handler: jsonRateLimitHandler(60),
});

export const userActionLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  handler: jsonRateLimitHandler(30),
});

// EA update + execution — 6000 / 10min per key (≈10/s sustained, generous).
export const eaPollingLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 6000,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByApiKeyOrIp,
  handler: jsonRateLimitHandler(120),
});

// EA /commands (compat-only; most traffic now handled inline via /update).
export const eaCommandsLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyByApiKeyOrIp,
  handler: jsonRateLimitHandler(30),
});
