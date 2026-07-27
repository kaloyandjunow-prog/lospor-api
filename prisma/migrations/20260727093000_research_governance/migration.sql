ALTER TABLE "ResearchExport"
  ADD COLUMN "definitionHash" TEXT,
  ADD COLUMN "scopeInstitutionIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "asOf" TIMESTAMP(3),
  ADD COLUMN "sourceVersion" TEXT,
  ADD COLUMN "sourceCommit" TEXT,
  ADD COLUMN "artifactKey" TEXT,
  ADD COLUMN "artifactFilename" TEXT,
  ADD COLUMN "artifactContentType" TEXT,
  ADD COLUMN "artifactByteSize" BIGINT,
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "leaseOwner" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "generatedAt" TIMESTAMP(3),
  ADD COLUMN "legacy" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "ResearchExport_status_leaseExpiresAt_idx"
  ON "ResearchExport"("status", "leaseExpiresAt");

UPDATE "ResearchExport"
SET
  "legacy" = true,
  "status" = 'FAILED',
  "error" = 'Legacy export was not frozen; create a new export generation.',
  "checksum" = NULL,
  "completedAt" = COALESCE("completedAt", CURRENT_TIMESTAMP)
WHERE "artifactKey" IS NULL;

UPDATE "ResearchCohort"
SET "visibility" = 'PRIVATE'
WHERE "visibility" = 'INSTITUTION' AND "institutionId" IS NULL;
