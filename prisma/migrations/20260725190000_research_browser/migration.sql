CREATE TYPE "ResearchCohortVisibility" AS ENUM ('PRIVATE', 'INSTITUTION');
CREATE TYPE "ResearchExportStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETE', 'FAILED');

CREATE TABLE "ResearchAccessGrant" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "institutionId" TEXT,
  "allInstitutions" BOOLEAN NOT NULL DEFAULT false,
  "canInspectCases" BOOLEAN NOT NULL DEFAULT true,
  "canExport" BOOLEAN NOT NULL DEFAULT false,
  "canExportOmop" BOOLEAN NOT NULL DEFAULT false,
  "grantedById" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ResearchAccessGrant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ResearchCohort" (
  "id" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "institutionId" TEXT,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "visibility" "ResearchCohortVisibility" NOT NULL DEFAULT 'PRIVATE',
  "definition" JSONB NOT NULL,
  "lastRunAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ResearchCohort_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ResearchExport" (
  "id" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "institutionId" TEXT,
  "name" TEXT NOT NULL,
  "format" TEXT NOT NULL,
  "status" "ResearchExportStatus" NOT NULL DEFAULT 'PENDING',
  "definition" JSONB NOT NULL,
  "rowCount" INTEGER,
  "checksum" TEXT,
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "ResearchExport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ResearchAccessGrant_userId_revokedAt_idx"
  ON "ResearchAccessGrant"("userId", "revokedAt");
CREATE INDEX "ResearchAccessGrant_institutionId_idx"
  ON "ResearchAccessGrant"("institutionId");
CREATE INDEX "ResearchAccessGrant_expiresAt_idx"
  ON "ResearchAccessGrant"("expiresAt");
CREATE INDEX "ResearchCohort_ownerId_updatedAt_idx"
  ON "ResearchCohort"("ownerId", "updatedAt");
CREATE INDEX "ResearchCohort_institutionId_visibility_idx"
  ON "ResearchCohort"("institutionId", "visibility");
CREATE INDEX "ResearchExport_ownerId_createdAt_idx"
  ON "ResearchExport"("ownerId", "createdAt");
CREATE INDEX "ResearchExport_status_createdAt_idx"
  ON "ResearchExport"("status", "createdAt");

ALTER TABLE "ResearchAccessGrant"
  ADD CONSTRAINT "ResearchAccessGrant_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchAccessGrant"
  ADD CONSTRAINT "ResearchAccessGrant_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchAccessGrant"
  ADD CONSTRAINT "ResearchAccessGrant_grantedById_fkey"
  FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ResearchCohort"
  ADD CONSTRAINT "ResearchCohort_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchCohort"
  ADD CONSTRAINT "ResearchCohort_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ResearchExport"
  ADD CONSTRAINT "ResearchExport_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchExport"
  ADD CONSTRAINT "ResearchExport_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE SET NULL ON UPDATE CASCADE;
