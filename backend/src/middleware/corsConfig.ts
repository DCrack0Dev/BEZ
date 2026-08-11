// Shared CORS origin allowlist for both the Express app and the Socket.IO server.
import { logger } from '../logging';

const DEFAULT_DEV_ORIGINS = ['http://localhost:3000', 'http://localhost:19006', 'http://localhost:8081'];

function parseAllowedOrigins(): string[] {
  const raw = process.env.ALLOWED_ORIGINS;
  if (!raw || raw.trim().length === 0) {
    logger.warn(
      `ALLOWED_ORIGINS not set — defaulting to local-dev-only origins: ${DEFAULT_DEV_ORIGINS.join(', ')}. ` +
        'Set ALLOWED_ORIGINS in production to your real frontend/mobile origin(s).'
    );
    return DEFAULT_DEV_ORIGINS;
  }
  if (raw.trim() === '*') {
    logger.warn(
      'ALLOWED_ORIGINS is set to "*" — this disables CORS origin restrictions entirely. ' +
        'This is unsafe for a live-money backend; set explicit origins instead.'
    );
    return ['*'];
  }
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

export const ALLOWED_ORIGINS: string[] = parseAllowedOrigins();

/** CORS origin callback usable by both `cors()` and Socket.IO's `cors.origin`. */
export function corsOriginCheck(
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void
) {
  // Allow non-browser requests (no Origin header, e.g. server-to-server/EA) through;
  // they're still gated by requireAuth/requireEaKey at the route level.
  if (!origin) return callback(null, true);
  if (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) {
    return callback(null, true);
  }
  return callback(new Error(`Origin ${origin} not allowed by CORS`));
}
