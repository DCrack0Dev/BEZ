-- CreateTable: Human-in-the-Loop gate overrides (user/approvals only, never written by AI directly)
CREATE TABLE IF NOT EXISTS "GateOverride" (
    "id" TEXT NOT NULL,
    "gateKey" TEXT NOT NULL,
    "gateType" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "currentValue" DECIMAL(65,30) NOT NULL,
    "defaultValue" DECIMAL(65,30) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "modifiedBy" TEXT,
    "modifiedAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "proposalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GateOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable: AI-proposed gate adjustments (always PENDING_APPROVAL until user taps)
CREATE TABLE IF NOT EXISTS "ModelGateProposal" (
    "id" TEXT NOT NULL,
    "targetGateKey" TEXT NOT NULL,
    "targetGateType" TEXT NOT NULL,
    "proposedAction" TEXT NOT NULL,
    "currentValue" DECIMAL(65,30) NOT NULL,
    "proposedValue" DECIMAL(65,30) NOT NULL,
    "rationale" TEXT NOT NULL,
    "expectedImpact" TEXT NOT NULL,
    "confidence" DECIMAL(65,30) NOT NULL,
    "sampleSize" INTEGER NOT NULL,
    "riskLevel" TEXT NOT NULL,
    "requiresPermission" BOOLEAN NOT NULL DEFAULT true,
    "autoApplyOnApproval" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewComment" TEXT,
    "appliedGateOverrideId" TEXT,
    "trainingRunId" TEXT,
    "modelVersion" TEXT,
    "symbol" TEXT,
    "timeframe" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelGateProposal_pkey" PRIMARY KEY ("id")
);

-- UniqueIndexes + Indexes (matches @@index / @unique in Prisma schema model)
CREATE UNIQUE INDEX IF NOT EXISTS "GateOverride_gateKey_key" ON "GateOverride"("gateKey");
CREATE INDEX IF NOT EXISTS "ModelGateProposal_status_idx" ON "ModelGateProposal"("status");
CREATE INDEX IF NOT EXISTS "ModelGateProposal_targetGateKey_idx" ON "ModelGateProposal"("targetGateKey");
CREATE INDEX IF NOT EXISTS "ModelGateProposal_createdAt_idx" ON "ModelGateProposal"("createdAt");
CREATE INDEX IF NOT EXISTS "ModelGateProposal_symbol_timeframe_idx" ON "ModelGateProposal"("symbol", "timeframe");
