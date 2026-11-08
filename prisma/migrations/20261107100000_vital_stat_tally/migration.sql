-- The running tally behind the vitals questions (10.2.0). Derived data: it
-- starts empty and fills from the finalised cases the first time it is read.
CREATE TABLE "VitalStatTally" (
    "scopeKey" TEXT NOT NULL,
    "band" TEXT NOT NULL,
    "sign" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "VitalStatTally_pkey" PRIMARY KEY ("scopeKey","band","sign","value")
);

CREATE TABLE "VitalStatTallyScope" (
    "scopeKey" TEXT NOT NULL,
    "band" TEXT NOT NULL,
    "sign" TEXT NOT NULL,
    "cases" INTEGER NOT NULL,

    CONSTRAINT "VitalStatTallyScope_pkey" PRIMARY KEY ("scopeKey","band","sign")
);

CREATE TABLE "VitalStatTallyCase" (
    "caseId" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "contribution" JSONB,
    "talliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VitalStatTallyCase_pkey" PRIMARY KEY ("caseId")
);

CREATE INDEX "VitalStatTallyCase_scopeKey_idx" ON "VitalStatTallyCase"("scopeKey");
