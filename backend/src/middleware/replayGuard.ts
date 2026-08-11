// Stopgap replay-protection: rejects requests carrying a stale `timestamp` field, but
// stays permissive (log-only) when no timestamp is present, since the EA (owned by
// another agent) does not send one yet. Tighten this once the EA always sends timestamps.
import { Request, Response, NextFunction } from 'express';
import { logger } from '../logging';

const REPLAY_WINDOW_MS = 30 * 1000;

export function replayGuard(req: Request, res: Response, next: NextFunction) {
  const timestamp = req.body?.timestamp;

  if (timestamp === undefined || timestamp === null) {
    logger.warn(`[replayGuard] No timestamp provided on ${req.method} ${req.path}, replay protection degraded`);
    return next();
  }

  const numericTimestamp = Number(timestamp);
  if (!Number.isFinite(numericTimestamp)) {
    logger.warn(`[replayGuard] Non-numeric timestamp provided on ${req.method} ${req.path}, ignoring`);
    return next();
  }

  const drift = Math.abs(Date.now() - numericTimestamp);
  if (drift > REPLAY_WINDOW_MS) {
    logger.warn(`[replayGuard] Rejected stale/future request on ${req.method} ${req.path} (drift=${drift}ms)`);
    return res.status(400).json({ success: false, error: 'Request timestamp outside allowed window (possible replay)' });
  }

  next();
}
