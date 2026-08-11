-- AlterTable
ALTER TABLE "AdvancedTradeJournal" ADD COLUMN     "cnnConfidence" DECIMAL(65,30),
ADD COLUMN     "detectedPattern" TEXT,
ADD COLUMN     "ensembleDecision" TEXT,
ADD COLUMN     "ensembleScore" DECIMAL(65,30),
ADD COLUMN     "explainability" JSONB,
ADD COLUMN     "fnnConfidence" DECIMAL(65,30),
ADD COLUMN     "lstmConfidence" DECIMAL(65,30),
ADD COLUMN     "marketRegime" TEXT,
ADD COLUMN     "patternConfidence" DECIMAL(65,30),
ADD COLUMN     "regimeConfidence" DECIMAL(65,30);

-- AlterTable
ALTER TABLE "TradeDNA" ADD COLUMN     "cnnOutput" JSONB,
ADD COLUMN     "confidenceError" DECIMAL(65,30),
ADD COLUMN     "detectedPattern" TEXT,
ADD COLUMN     "ensembleOutput" JSONB,
ADD COLUMN     "entryLatencyMs" DECIMAL(65,30),
ADD COLUMN     "executionQuality" DECIMAL(65,30),
ADD COLUMN     "fnnOutput" JSONB,
ADD COLUMN     "lstmOutput" JSONB,
ADD COLUMN     "marketRegime" TEXT,
ADD COLUMN     "misclassificationReason" TEXT,
ADD COLUMN     "patternConfidence" DECIMAL(65,30),
ADD COLUMN     "predictionError" DECIMAL(65,30),
ADD COLUMN     "psychologyScore" DECIMAL(65,30),
ADD COLUMN     "regimeConfidence" DECIMAL(65,30),
ADD COLUMN     "slippagePips" DECIMAL(65,30);

-- CreateTable
CREATE TABLE "EnsemblePrediction" (
    "id" TEXT NOT NULL,
    "ticket" TEXT,
    "signalId" TEXT,
    "symbol" TEXT NOT NULL,
    "proposedDirection" TEXT NOT NULL,
    "finalScore" DECIMAL(65,30) NOT NULL,
    "decision" TEXT NOT NULL,
    "fnnVersion" TEXT,
    "cnnVersion" TEXT,
    "lstmVersion" TEXT,
    "fnnOutput" JSONB,
    "cnnOutput" JSONB,
    "lstmOutput" JSONB,
    "ruleConfidence" DECIMAL(65,30) NOT NULL,
    "explainability" JSONB NOT NULL,
    "regime" TEXT NOT NULL,
    "regimeConfidence" DECIMAL(65,30) NOT NULL,
    "weightsUsed" JSONB NOT NULL,
    "perModelScores" JSONB NOT NULL,
    "reasons" TEXT[],
    "hardGateEnabled" BOOLEAN NOT NULL DEFAULT false,
    "predictionLogId" TEXT,
    "tradeDnaId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnsemblePrediction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EnsemblePrediction_createdAt_idx" ON "EnsemblePrediction"("createdAt");

-- CreateIndex
CREATE INDEX "EnsemblePrediction_symbol_createdAt_idx" ON "EnsemblePrediction"("symbol", "createdAt");

-- CreateIndex
CREATE INDEX "EnsemblePrediction_decision_idx" ON "EnsemblePrediction"("decision");

-- CreateIndex
CREATE INDEX "EnsemblePrediction_tradeDnaId_idx" ON "EnsemblePrediction"("tradeDnaId");

-- CreateIndex
CREATE INDEX "TradeDNA_marketRegime_idx" ON "TradeDNA"("marketRegime");

-- AddForeignKey
ALTER TABLE "EnsemblePrediction" ADD CONSTRAINT "EnsemblePrediction_tradeDnaId_fkey" FOREIGN KEY ("tradeDnaId") REFERENCES "TradeDNA"("id") ON DELETE SET NULL ON UPDATE CASCADE;
