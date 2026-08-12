-- AlterTable
ALTER TABLE "FeatureSet" ADD COLUMN "bbWidth" DECIMAL(65,30),
ADD COLUMN "volumeRatio" DECIMAL(65,30),
ADD COLUMN "newsImpact" TEXT,
ADD COLUMN "similarSetupWinRate" DECIMAL(65,30) NOT NULL DEFAULT 0,
ADD COLUMN "riskScore" TEXT NOT NULL DEFAULT 'MEDIUM',
ADD COLUMN "bullishStructurePercent" DECIMAL(65,30) NOT NULL DEFAULT 0,
ADD COLUMN "bearishStructurePercent" DECIMAL(65,30) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "FeatureSet" DROP COLUMN "recentSweeps",
DROP COLUMN "poiZones";
