-- CreateTable
CREATE TABLE "Tick" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "bid" DECIMAL(65,30) NOT NULL,
    "ask" DECIMAL(65,30) NOT NULL,
    "spread" DECIMAL(65,30) NOT NULL,
    "volume" DECIMAL(65,30) NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tick_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Candle" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "open" DECIMAL(65,30) NOT NULL,
    "high" DECIMAL(65,30) NOT NULL,
    "low" DECIMAL(65,30) NOT NULL,
    "close" DECIMAL(65,30) NOT NULL,
    "volume" DECIMAL(65,30) NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Candle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CandleIndicator" (
    "id" TEXT NOT NULL,
    "candleId" TEXT NOT NULL,
    "atr" DECIMAL(65,30) NOT NULL,
    "rsi" DECIMAL(65,30) NOT NULL,
    "macd" DECIMAL(65,30),
    "macdSignal" DECIMAL(65,30),
    "macdHistogram" DECIMAL(65,30),
    "ema20" DECIMAL(65,30) NOT NULL,
    "ema50" DECIMAL(65,30) NOT NULL,
    "ema100" DECIMAL(65,30),
    "vwap" DECIMAL(65,30) NOT NULL,
    "adx" DECIMAL(65,30) NOT NULL,
    "bbUpper" DECIMAL(65,30) NOT NULL,
    "bbMiddle" DECIMAL(65,30) NOT NULL,
    "bbLower" DECIMAL(65,30) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CandleIndicator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeatureSet" (
    "id" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "timeframe" TEXT NOT NULL,
    "trendStrength" DECIMAL(65,30) NOT NULL,
    "trendDirection" TEXT NOT NULL,
    "ema20DistancePips" DECIMAL(65,30) NOT NULL,
    "ema50DistancePips" DECIMAL(65,30) NOT NULL,
    "adxValue" DECIMAL(65,30) NOT NULL,
    "slope20" DECIMAL(65,30),
    "slope50" DECIMAL(65,30),
    "momentumDirection" TEXT NOT NULL,
    "rsiStrength" DECIMAL(65,30) NOT NULL,
    "macdMomentum" TEXT NOT NULL,
    "cciValue" DECIMAL(65,30),
    "williamsR" DECIMAL(65,30),
    "atrRatio" DECIMAL(65,30) NOT NULL,
    "volatility" TEXT NOT NULL,
    "bbPercentWidth" DECIMAL(65,30),
    "bbPosition" DECIMAL(65,30),
    "liquiditySweep" TEXT NOT NULL,
    "recentSweeps" JSONB,
    "swingHighs" JSONB NOT NULL,
    "swingLows" JSONB NOT NULL,
    "nearestSupport" DECIMAL(65,30),
    "nearestResistance" DECIMAL(65,30),
    "structureType" TEXT,
    "structureStrength" DECIMAL(65,30),
    "fvgPresent" TEXT NOT NULL,
    "fvgDetails" JSONB,
    "orderBlockConfirmed" TEXT NOT NULL,
    "orderBlockDetails" JSONB,
    "poiZones" JSONB,
    "marketSession" TEXT NOT NULL,
    "prevCandlePattern" TEXT,
    "prevCandleBodyPct" DECIMAL(65,30),
    "prevCandleType" TEXT,
    "normalizedFeatures" JSONB NOT NULL,
    "candleId" TEXT NOT NULL,
    "candleIndicatorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeatureSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountSnapshot" (
    "id" TEXT NOT NULL,
    "balance" DECIMAL(65,30) NOT NULL,
    "equity" DECIMAL(65,30) NOT NULL,
    "margin" DECIMAL(65,30) NOT NULL,
    "marginLevel" DECIMAL(65,30),
    "floatingPL" DECIMAL(65,30) NOT NULL,
    "openPositions" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Position" (
    "id" TEXT NOT NULL,
    "ticket" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "openPrice" DECIMAL(65,30) NOT NULL,
    "currentPrice" DECIMAL(65,30) NOT NULL,
    "sl" DECIMAL(65,30),
    "tp" DECIMAL(65,30),
    "lotSize" DECIMAL(65,30) NOT NULL,
    "profit" DECIMAL(65,30) NOT NULL,
    "openTimestamp" TIMESTAMP(3) NOT NULL,
    "closeTimestamp" TIMESTAMP(3),
    "isOpen" BOOLEAN NOT NULL DEFAULT true,
    "trailingPhase" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tradeDnaId" TEXT,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TradeDNA" (
    "id" TEXT NOT NULL,
    "ticket" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "entryPrice" DECIMAL(65,30) NOT NULL,
    "stopLoss" DECIMAL(65,30) NOT NULL,
    "takeProfit" DECIMAL(65,30) NOT NULL,
    "lotSize" DECIMAL(65,30) NOT NULL,
    "riskPercent" DECIMAL(65,30) NOT NULL,
    "outcome" TEXT NOT NULL,
    "profitPips" DECIMAL(65,30) NOT NULL,
    "profitPercent" DECIMAL(65,30) NOT NULL,
    "profitDollars" DECIMAL(65,30) NOT NULL,
    "aiConfidence" DECIMAL(65,30) NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "mistakes" TEXT[],
    "lessons" TEXT[],
    "notes" TEXT,
    "entryFeatures" JSONB NOT NULL,
    "closeFeatures" JSONB,
    "screenshots" JSONB,
    "entryTimestamp" TIMESTAMP(3) NOT NULL,
    "closeTimestamp" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TradeDNA_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdvancedTradeJournal" (
    "id" TEXT NOT NULL,
    "ticket" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "marketSnapshot" JSONB NOT NULL,
    "marketSession" TEXT NOT NULL,
    "indicators" JSONB NOT NULL,
    "featureSet" JSONB NOT NULL,
    "aiPrediction" TEXT,
    "aiConfidence" DECIMAL(65,30),
    "aiExpectedRisk" DECIMAL(65,30),
    "aiExpectedReward" DECIMAL(65,30),
    "aiExpectedDuration" DECIMAL(65,30),
    "modelVersion" TEXT,
    "entryPrice" DECIMAL(65,30) NOT NULL,
    "executionPrice" DECIMAL(65,30) NOT NULL,
    "slippage" DECIMAL(65,30) NOT NULL,
    "spreadAtEntry" DECIMAL(65,30) NOT NULL,
    "sl" DECIMAL(65,30) NOT NULL,
    "tp" DECIMAL(65,30) NOT NULL,
    "lotSize" DECIMAL(65,30) NOT NULL,
    "riskPercent" DECIMAL(65,30) NOT NULL,
    "riskScore" DECIMAL(65,30),
    "outcome" TEXT NOT NULL,
    "profitPips" DECIMAL(65,30) NOT NULL,
    "profitPercent" DECIMAL(65,30) NOT NULL,
    "profitDollars" DECIMAL(65,30) NOT NULL,
    "entryTimestamp" TIMESTAMP(3) NOT NULL,
    "closeTimestamp" TIMESTAMP(3),
    "durationMinutes" DECIMAL(65,30),
    "reasonForEntry" TEXT,
    "reasonForExit" TEXT,
    "notes" TEXT,
    "screenshotRefs" JSONB,
    "tradeDnaId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdvancedTradeJournal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EconomicEvent" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "impact" TEXT NOT NULL,
    "actual" TEXT,
    "forecast" TEXT,
    "previous" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EconomicEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketSession" (
    "id" TEXT NOT NULL,
    "session" TEXT NOT NULL,
    "startUTC" TEXT NOT NULL,
    "endUTC" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lesson" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "impact" TEXT NOT NULL,
    "dnaIds" TEXT[],
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Lesson_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelCandidate" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "trainingDate" TIMESTAMP(3) NOT NULL,
    "winRate" DECIMAL(65,30) NOT NULL,
    "profitFactor" DECIMAL(65,30) NOT NULL,
    "avgProfit" DECIMAL(65,30) NOT NULL,
    "avgRr" DECIMAL(65,30),
    "sharpeRatio" DECIMAL(65,30) NOT NULL,
    "maxDrawdown" DECIMAL(65,30),
    "accuracy" DECIMAL(65,30),
    "precision" DECIMAL(65,30),
    "recall" DECIMAL(65,30),
    "f1Score" DECIMAL(65,30),
    "trainingLoss" DECIMAL(65,30),
    "validationLoss" DECIMAL(65,30),
    "tradeFrequency" DECIMAL(65,30),
    "stability" DECIMAL(65,30),
    "status" TEXT NOT NULL,
    "deploymentRec" TEXT NOT NULL,
    "recReason" TEXT NOT NULL,
    "isProduction" BOOLEAN NOT NULL DEFAULT false,
    "metricsJson" JSONB,
    "comparisonJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelRegistry" (
    "id" TEXT NOT NULL,
    "productionVersion" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelRegistry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainingRun" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "epochs" INTEGER,
    "trainSamples" INTEGER,
    "valSamples" INTEGER,
    "holdoutSamples" INTEGER,
    "trainingLoss" DECIMAL(65,30),
    "validationLoss" DECIMAL(65,30),
    "accuracy" DECIMAL(65,30),
    "precision" DECIMAL(65,30),
    "recall" DECIMAL(65,30),
    "f1Score" DECIMAL(65,30),
    "profitFactor" DECIMAL(65,30),
    "sharpeRatio" DECIMAL(65,30),
    "maxDrawdown" DECIMAL(65,30),
    "historyJson" JSONB,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "candidateId" TEXT,

    CONSTRAINT "TrainingRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PredictionLog" (
    "id" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "symbol" TEXT,
    "buyProbability" DECIMAL(65,30) NOT NULL,
    "sellProbability" DECIMAL(65,30) NOT NULL,
    "holdProbability" DECIMAL(65,30) NOT NULL,
    "confidence" DECIMAL(65,30) NOT NULL,
    "expectedRisk" DECIMAL(65,30),
    "expectedReward" DECIMAL(65,30),
    "expectedDuration" DECIMAL(65,30),
    "predictedAction" TEXT NOT NULL,
    "featuresSnapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PredictionLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemAlert" (
    "id" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "value" DECIMAL(65,30) NOT NULL,
    "threshold" DECIMAL(65,30) NOT NULL,
    "message" TEXT NOT NULL,
    "acknowledged" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "version" TEXT,
    "details" JSONB,
    "actor" TEXT NOT NULL DEFAULT 'system',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostTradeAnalysis" (
    "id" TEXT NOT NULL,
    "ticket" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "profitPips" DECIMAL(65,30) NOT NULL,
    "profitDollars" DECIMAL(65,30) NOT NULL,
    "modelVersion" TEXT,
    "aiConfidence" DECIMAL(65,30),
    "analysis" JSONB NOT NULL,
    "lessons" TEXT[],
    "labeledSampleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostTradeAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BacktestRun" (
    "id" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "symbol" TEXT,
    "status" TEXT NOT NULL,
    "winRate" DECIMAL(65,30),
    "profitFactor" DECIMAL(65,30),
    "sharpeRatio" DECIMAL(65,30),
    "maxDrawdown" DECIMAL(65,30),
    "totalTrades" INTEGER,
    "monthlyReturns" JSONB,
    "tradeDistribution" JSONB,
    "reportPath" TEXT,
    "metricsJson" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BacktestRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Tick_symbol_timestamp_idx" ON "Tick"("symbol", "timestamp");

-- CreateIndex
CREATE INDEX "Candle_symbol_timeframe_timestamp_idx" ON "Candle"("symbol", "timeframe", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "Candle_symbol_timeframe_timestamp_key" ON "Candle"("symbol", "timeframe", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "CandleIndicator_candleId_key" ON "CandleIndicator"("candleId");

-- CreateIndex
CREATE UNIQUE INDEX "FeatureSet_candleId_key" ON "FeatureSet"("candleId");

-- CreateIndex
CREATE UNIQUE INDEX "FeatureSet_candleIndicatorId_key" ON "FeatureSet"("candleIndicatorId");

-- CreateIndex
CREATE INDEX "FeatureSet_symbol_timeframe_createdAt_idx" ON "FeatureSet"("symbol", "timeframe", "createdAt");

-- CreateIndex
CREATE INDEX "AccountSnapshot_timestamp_idx" ON "AccountSnapshot"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "Position_ticket_key" ON "Position"("ticket");

-- CreateIndex
CREATE INDEX "Position_isOpen_idx" ON "Position"("isOpen");

-- CreateIndex
CREATE INDEX "Position_createdAt_idx" ON "Position"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TradeDNA_ticket_key" ON "TradeDNA"("ticket");

-- CreateIndex
CREATE INDEX "TradeDNA_outcome_idx" ON "TradeDNA"("outcome");

-- CreateIndex
CREATE INDEX "TradeDNA_entryTimestamp_idx" ON "TradeDNA"("entryTimestamp");

-- CreateIndex
CREATE UNIQUE INDEX "AdvancedTradeJournal_ticket_key" ON "AdvancedTradeJournal"("ticket");

-- CreateIndex
CREATE INDEX "AdvancedTradeJournal_outcome_idx" ON "AdvancedTradeJournal"("outcome");

-- CreateIndex
CREATE INDEX "AdvancedTradeJournal_symbol_idx" ON "AdvancedTradeJournal"("symbol");

-- CreateIndex
CREATE INDEX "AdvancedTradeJournal_entryTimestamp_idx" ON "AdvancedTradeJournal"("entryTimestamp");

-- CreateIndex
CREATE INDEX "EconomicEvent_timestamp_idx" ON "EconomicEvent"("timestamp");

-- CreateIndex
CREATE INDEX "EconomicEvent_impact_idx" ON "EconomicEvent"("impact");

-- CreateIndex
CREATE UNIQUE INDEX "ModelCandidate_version_key" ON "ModelCandidate"("version");

-- CreateIndex
CREATE INDEX "ModelCandidate_status_idx" ON "ModelCandidate"("status");

-- CreateIndex
CREATE INDEX "ModelCandidate_isProduction_idx" ON "ModelCandidate"("isProduction");

-- CreateIndex
CREATE INDEX "TrainingRun_version_idx" ON "TrainingRun"("version");

-- CreateIndex
CREATE INDEX "TrainingRun_status_idx" ON "TrainingRun"("status");

-- CreateIndex
CREATE INDEX "TrainingRun_startedAt_idx" ON "TrainingRun"("startedAt");

-- CreateIndex
CREATE INDEX "PredictionLog_modelVersion_createdAt_idx" ON "PredictionLog"("modelVersion", "createdAt");

-- CreateIndex
CREATE INDEX "PredictionLog_createdAt_idx" ON "PredictionLog"("createdAt");

-- CreateIndex
CREATE INDEX "SystemAlert_severity_createdAt_idx" ON "SystemAlert"("severity", "createdAt");

-- CreateIndex
CREATE INDEX "SystemAlert_acknowledged_idx" ON "SystemAlert"("acknowledged");

-- CreateIndex
CREATE INDEX "AuditLog_category_createdAt_idx" ON "AuditLog"("category", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_version_idx" ON "AuditLog"("version");

-- CreateIndex
CREATE UNIQUE INDEX "PostTradeAnalysis_ticket_key" ON "PostTradeAnalysis"("ticket");

-- CreateIndex
CREATE INDEX "PostTradeAnalysis_createdAt_idx" ON "PostTradeAnalysis"("createdAt");

-- CreateIndex
CREATE INDEX "PostTradeAnalysis_outcome_idx" ON "PostTradeAnalysis"("outcome");

-- CreateIndex
CREATE INDEX "BacktestRun_modelVersion_idx" ON "BacktestRun"("modelVersion");

-- CreateIndex
CREATE INDEX "BacktestRun_startedAt_idx" ON "BacktestRun"("startedAt");

-- AddForeignKey
ALTER TABLE "CandleIndicator" ADD CONSTRAINT "CandleIndicator_candleId_fkey" FOREIGN KEY ("candleId") REFERENCES "Candle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeatureSet" ADD CONSTRAINT "FeatureSet_candleId_fkey" FOREIGN KEY ("candleId") REFERENCES "Candle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeatureSet" ADD CONSTRAINT "FeatureSet_candleIndicatorId_fkey" FOREIGN KEY ("candleIndicatorId") REFERENCES "CandleIndicator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_tradeDnaId_fkey" FOREIGN KEY ("tradeDnaId") REFERENCES "TradeDNA"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvancedTradeJournal" ADD CONSTRAINT "AdvancedTradeJournal_tradeDnaId_fkey" FOREIGN KEY ("tradeDnaId") REFERENCES "TradeDNA"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainingRun" ADD CONSTRAINT "TrainingRun_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "ModelCandidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
