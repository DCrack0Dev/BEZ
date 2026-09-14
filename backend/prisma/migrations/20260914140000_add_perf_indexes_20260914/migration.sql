-- Fix P2002 FeatureSet cascaded Postgres connection starvation + AI Lab
-- dashboard 10s latency /ea/update 28s latency on Render Free cap=5 connections.
-- Additive IF NOT EXISTS indexes only; no column changes, no drops.

-- 0) Schema small additive: FeatureSet missing updatedAt (used by upsert ON CONFLICT SET updatedAt)
ALTER TABLE IF EXISTS "FeatureSet" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT NOW();

-- 1) AI Lab dashboard: AdvancedTradeJournal closed (WIN/LOSS/BREAKEVEN) closed-by-date
CREATE INDEX IF NOT EXISTS "AdvancedTradeJournal_outcome_closeTimestamp_idx"
  ON "AdvancedTradeJournal"("outcome", "closeTimestamp" DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS "AdvancedTradeJournal_symbol_outcome_closeTimestamp_idx"
  ON "AdvancedTradeJournal"("symbol", "outcome", "closeTimestamp" DESC NULLS LAST);

-- 2) PredictionLog reverse-chronological for dashboard.getDashboard (take:50)
CREATE INDEX IF NOT EXISTS "PredictionLog_createdAt_idx"
  ON "PredictionLog"("createdAt" DESC);
CREATE INDEX IF NOT EXISTS "PredictionLog_modelVersion_createdAt_idx"
  ON "PredictionLog"("modelVersion", "createdAt" DESC);

-- 3) ModelCandidate / TrainingRun dashboard sorts + version lookups
CREATE INDEX IF NOT EXISTS "ModelCandidate_trainingDate_idx"
  ON "ModelCandidate"("trainingDate" DESC);
CREATE INDEX IF NOT EXISTS "TrainingRun_startedAt_idx"
  ON "TrainingRun"("startedAt" DESC);
CREATE INDEX IF NOT EXISTS "TrainingRun_status_startedAt_idx"
  ON "TrainingRun"("status", "startedAt" DESC);

-- 4) FeatureSet.latestFeature() hotspot (getLatestFeature / getFeaturesBySymbol)
--    Schema has @@index([symbol, timeframe, createdAt]) already; add createdAt-desc
--    explicit variant so ORDER BY createdAt DESC LIMIT 50 uses index scan not seq.
CREATE INDEX IF NOT EXISTS "FeatureSet_symbol_createdAt_idx"
  ON "FeatureSet"("symbol", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "FeatureSet_symbol_timeframe_createdAt_desc_idx"
  ON "FeatureSet"("symbol", "timeframe", "createdAt" DESC);

-- 5) Position / TradeDNA / AdvancedTradeJournal symbol filters used by journal
CREATE INDEX IF NOT EXISTS "Position_isOpen_symbol_idx"
  ON "Position"("isOpen", "symbol");
CREATE INDEX IF NOT EXISTS "Position_symbol_closeTimestamp_idx"
  ON "Position"("symbol", "closeTimestamp" DESC NULLS LAST);

-- 6) Journal reconciler: AdvancedTradeJournal OPEN rows + reasonForExit
CREATE INDEX IF NOT EXISTS "AdvancedTradeJournal_reasonForExit_idx"
  ON "AdvancedTradeJournal"("reasonForExit");
CREATE INDEX IF NOT EXISTS "AdvancedTradeJournal_outcome_symbol_idx"
  ON "AdvancedTradeJournal"("outcome", "symbol");
