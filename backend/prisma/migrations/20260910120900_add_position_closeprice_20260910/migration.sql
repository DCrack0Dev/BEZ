-- Close-time final executed price (real MT5 close price) for Position rows:
-- Used by boot reconciler + App Journal pickBestProfit to recompute correct USD P&L
-- even when the last-heartbeat unrealized p.profit was mid-flight stale snapshot.
ALTER TABLE IF EXISTS "Position" ADD COLUMN IF NOT EXISTS "closePrice" DECIMAL(65,30);
CREATE INDEX IF NOT EXISTS "Position_closePrice_idx" ON "Position"("closePrice");
