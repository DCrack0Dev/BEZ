-- CreateTable
CREATE TABLE "ModelArtifact" (
    "id" TEXT NOT NULL,
    "artifactKey" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "version" TEXT,
    "data" BYTEA NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "mimeType" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ModelArtifact_artifactKey_key" ON "ModelArtifact"("artifactKey");

-- CreateIndex
CREATE INDEX "ModelArtifact_type_idx" ON "ModelArtifact"("type");

-- CreateIndex
CREATE INDEX "ModelArtifact_version_idx" ON "ModelArtifact"("version");
