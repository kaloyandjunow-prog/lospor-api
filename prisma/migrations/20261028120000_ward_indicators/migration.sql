-- Ward indicators (10.0.0): the thresholds set in Status, and a derived cache
-- of each case's figures. The cache is not part of the record; dropping it
-- only means the figures are worked out again.

-- CreateTable
CREATE TABLE "IndicatorPolicy" (
    "id" TEXT NOT NULL DEFAULT 'local',
    "config" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IndicatorPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseIndicatorSummary" (
    "caseId" TEXT NOT NULL,
    "institutionId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "clinicalRevision" INTEGER NOT NULL,
    "eventRevision" INTEGER NOT NULL,
    "relationalRevision" INTEGER NOT NULL,
    "configKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseIndicatorSummary_pkey" PRIMARY KEY ("caseId")
);

-- CreateIndex
CREATE INDEX "CaseIndicatorSummary_institutionId_startedAt_idx" ON "CaseIndicatorSummary"("institutionId", "startedAt");

-- AddForeignKey
ALTER TABLE "CaseIndicatorSummary" ADD CONSTRAINT "CaseIndicatorSummary_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
