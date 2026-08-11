// Authentication middleware: JWT for end-users/mobile app, static API key for the EA.
//
// Refresh-token design decision: this backend currently has no DB access available to
// this module's scope (database/ is owned by another agent), so refresh tokens are
// implemented as long-lived, self-contained signed JWTs (`type: 'refresh'`) rather than
// DB-backed opaque tokens. Trade-off: we cannot revoke an individual refresh token before
// its expiry (no server-side blacklist). This is an accepted stopgap — if/when a
// revocation store becomes available, swap `verifyToken` + `type: 'refresh'` here for a
// DB-checked lookup without changing the public API of this module.
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { logger } from '../logging';

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

const DEV_FALLBACK_JWT_SECRET = 'dev-only-insecure-secret-do-not-use-in-production';

// Resolve JWT secret at module load time so a missing secret fails startup loudly
// in production instead of silently accepting unsigned/forgeable tokens.
export const JWT_SECRET: string = (() => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (IS_PROD) {
      throw new Error(
        'FATAL: JWT_SECRET environment variable is required when NODE_ENV=production. Refusing to start.'
      );
    }
    logger.warn('JWT_SECRET not set — using an insecure development fallback secret. DO NOT use in production.');
    return DEV_FALLBACK_JWT_SECRET;
  }
  return secret;
})();

// Resolve the EA API key at module load time for the same reason.
export const EA_API_KEY: string | undefined = (() => {
  const key = process.env.EA_API_KEY;
  if (!key) {
    if (IS_PROD) {
      throw new Error(
        'FATAL: EA_API_KEY environment variable is required when NODE_ENV=production. Refusing to start.'
      );
    }
    logger.warn('EA_API_KEY not set — EA-authenticated endpoints will reject all requests until it is configured.');
  }
  return key;
})();

const ACCESS_TOKEN_TTL = '24h';
const REFRESH_TOKEN_TTL = '30d';

export interface AccessTokenPayload {
  sub: string;
  type: 'access';
  plan?: string;
  maxTrades?: number;
  maxOpenTrades?: number;
  [key: string]: any;
}

export interface RefreshTokenPayload {
  sub: string;
  type: 'refresh';
}

export function signAccessToken(subject: string, extra: Record<string, any> = {}): string {
  return jwt.sign({ sub: subject, type: 'access', ...extra }, JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL });
}

export function signRefreshToken(subject: string): string {
  return jwt.sign({ sub: subject, type: 'refresh' }, JWT_SECRET, { expiresIn: REFRESH_TOKEN_TTL });
}

export function verifyToken<T = any>(token: string): T {
  return jwt.verify(token, JWT_SECRET) as T;
}

function sha256(value: string): Buffer {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

// Constant-time comparison that never throws on length mismatch: both inputs are
// hashed to fixed-length digests first, so `crypto.timingSafeEqual` always receives
// equal-length buffers regardless of the original string lengths.
export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = sha256(a);
  const bufB = sha256(b);
  return crypto.timingSafeEqual(bufA, bufB);
}

export function verifyEaApiKey(candidate: string | undefined | null): boolean {
  if (!EA_API_KEY || !candidate) return false;
  return constantTimeEquals(candidate, EA_API_KEY);
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AccessTokenPayload;
    }
  }
}

/**
 * Requires a valid `Authorization: Bearer <jwt>` access token. Intended for
 * end-user / mobile-app routes that read or mutate account/trading state.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Missing or malformed Authorization header' });
  }
  const token = header.slice('Bearer '.length).trim();
  try {
    const decoded = verifyToken<AccessTokenPayload>(token);
    if (decoded.type !== 'access') {
      return res.status(401).json({ success: false, error: 'Invalid token type' });
    }
    req.user = decoded;
    next();
  } catch (err) {
    logger.warn('Rejected request with invalid/expired JWT', (err as Error).message);
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
}

/**
 * Requires a valid `x-api-key` header matching EA_API_KEY. Intended for
 * EA-originated polling endpoints, which authenticate with their own static key
 * rather than end-user JWTs.
 */
export function requireEaKey(req: Request, res: Response, next: NextFunction) {
  const key = req.header('x-api-key');
  if (!verifyEaApiKey(key)) {
    logger.warn('Rejected EA request with invalid/missing x-api-key');
    return res.status(401).json({ success: false, error: 'Invalid or missing API key' });
  }
  next();
}
