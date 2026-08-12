// Replay-protection for authenticated app/EA writes.
// EA heartbeats use broker/server clocks that often diverge from Render UTC by
// minutes (sometimes hours). Rejecting on a tight window caused HTTP 400 storms
// on POST /api/ea/update and broke the app feed. We:
//   - allow a wide skew window for EA routes
//   - log large drifts without dropping the heartbeat
import { Request, Response, NextFunction } from 'express';
import { logger } from '../logging';

/** Mobile / manual actions — still reject obvious replays. */
const APP_REPLAY_WINDOW_MS = 5 * 60 * 1000;
/** EA broker clock vs UTC can be far off; never drop heartbeats on skew alone. */
const EA_REPLAY_WARN_MS = 15 * 60 * 1000;

function isEaPath(path: string): boolean {
  return path.includes('/ea/');
}

export function replayGuard(req: Request, res: Response, next: NextFunction) {
  const timestamp = req.body?.timestamp;

  if (timestamp === undefined || timestamp === null) {
    return next();
  }

  const numericTimestamp = Number(timestamp);
  if (!Number.isFinite(numericTimestamp)) {
    logger.warn(`[replayGuard] Non-numeric timestamp on ${req.method} ${req.path}, ignoring`);
    return next();
  }

  // Accept seconds or milliseconds from EA / app.
  const ms = numericTimestamp < 1e12 ? numericTimestamp * 1000 : numericTimestamp;
  const drift = Math.abs(Date.now() - ms);

  if (isEaPath(req.path)) {
    if (drift > EA_REPLAY_WARN_MS) {
      logger.warn(
        `[replayGuard] EA clock skew on ${req.method} ${req.path} (drift=${Math.round(drift / 1000)}s) — accepting`
      );
    }
    return next();
  }

  if (drift > APP_REPLAY_WINDOW_MS) {
    logger.warn(`[replayGuard] Rejected stale/future request on ${req.method} ${req.path} (drift=${drift}ms)`);
    return res.status(400).json({ success: false, error: 'Request timestamp outside allowed window (possible replay)' });
  }

  next();
}
