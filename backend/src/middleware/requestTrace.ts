// Structured trace logging for EA-originated HTTP requests.
// Attaches a correlation ID, records safe request metadata, and emits a
// single structured log line on response finish with auth + rate verdicts.
import { randomUUID } from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { logger } from '../logging';

const TRUNCATE_UA_AT = 120;
const TRUNCATE_IP_AT = 64;

function truncate(s: string | undefined, n: number): string {
  if (!s) return '';
  const trimmed = s.trim();
  return trimmed.length <= n ? trimmed : trimmed.slice(0, n) + '…';
}

function firstHopXff(raw: string | undefined): string {
  if (!raw) return '';
  const firstComma = raw.indexOf(',');
  const token = firstComma >= 0 ? raw.slice(0, firstComma) : raw;
  return truncate(token.trim(), TRUNCATE_IP_AT);
}

function uaFrom(req: Request): string {
  return truncate(req.header('user-agent'), TRUNCATE_UA_AT);
}

export interface EaTraceLocals {
  authVerdict?: 'PASS' | 'FAIL_MISSING' | 'FAIL_INVALID';
  rateVerdict?: string;
}

/**
 * Installed BEFORE auth/rate middleware on /api/ea/* routes.
 * Writes X-Request-Id response header and hooks res.finish to emit one log.
 * Auth/rate middleware later populates res.locals.authVerdict / res.locals.rateVerdict.
 */
export function eaTraceMiddleware(req: Request, res: Response, next: NextFunction): void {
  const reqId = (req.header('x-request-id') || '').trim() || randomUUID();
  res.setHeader('X-Request-Id', reqId);
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const startedAt = Date.now();
  const method = req.method;
  const path = req.baseUrl ? (req.baseUrl + (req.path || '')) : (req.path || req.url);
  const firstHopIp = firstHopXff(req.header('x-forwarded-for')) || truncate(req.header('x-real-ip'), TRUNCATE_IP_AT) || '';
  const ua = uaFrom(req);
  const proto = req.header('x-forwarded-proto') || req.protocol || '';

  res.on('finish', () => {
    const locals = (res.locals as unknown as EaTraceLocals) || {};
    const auth = locals.authVerdict || (res.statusCode === 401 ? 'FAIL_UNKNOWN' : 'PASS');
    const rate = locals.rateVerdict || (res.statusCode === 429 ? 'UNKNOWN:LIMITED' : 'NA:PASS');
    const latencyMs = Date.now() - startedAt;
    const contentType = String(res.getHeader('Content-Type') || '').slice(0, 80);
    const isHtml = contentType.includes('text/html') || contentType.includes('text/xhtml');
    const origin = (res.getHeader('Server') ||
                    res.getHeader('X-Powered-By') ||
                    (isHtml ? 'UPSTREAM_CF_OR_RENDER' : 'EXPRESS')) as string;
    const statusSource =
      res.statusCode === 429
        ? (isHtml ? 'UPSTREAM_HTML_CF_CHALLENGE' : (rate.includes('LIMITED') ? 'EXPRESS_RATE_LIMITER' : 'UNIDENTIFIED_429'))
        : res.statusCode === 503
          ? (isHtml ? 'UPSTREAM_HTML_OVERLOAD' : 'EXPRESS_APP_503')
          : 'EXPRESS_APP';
    logger.info('[EA_TRACE]', {
      reqId,
      ts: new Date().toISOString(),
      method,
      path,
      status: res.statusCode,
      latencyMs,
      auth,
      rate,
      ua,
      ip: firstHopIp,
      proto,
      contentType,
      statusSource,
      originHint: String(origin).slice(0, 64),
    });
  });

  next();
}
