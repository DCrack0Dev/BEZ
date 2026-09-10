-- App-user-owned bot settings (auto trading toggle, AI trading, timezone gates, spread limit, etc).
-- Persisted to DB because Render containers have EPHEMERAL filesystems → every restart
-- resets in-memory memory; without DB persistence, user autoTradingEnabled=true in the app
-- would randomly reset to `false` default on each deploy/pod cycle.
-- Also used to block EA heartbeat from overwriting app-user flags (heartbeat spread is
-- explicitly blacklisted for these keys).
CREATE TABLE IF NOT EXISTS "BotSetting" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "boolValue" BOOLEAN,
  "intValue" INTEGER,
  "floatValue" DECIMAL(65,30),
  "stringValue" TEXT,
  "jsonValue" JSONB,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BotSetting_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "BotSetting_key_key" ON "BotSetting"("key");
CREATE INDEX IF NOT EXISTS "BotSetting_key_idx" ON "BotSetting"("key");
