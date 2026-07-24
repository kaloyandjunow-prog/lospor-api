ALTER TABLE "CaseEvent"
  ADD COLUMN IF NOT EXISTS "infId" TEXT,
  ADD COLUMN IF NOT EXISTS "fluidId" TEXT,
  ADD COLUMN IF NOT EXISTS "rate" TEXT,
  ADD COLUMN IF NOT EXISTS "concentration" TEXT,
  ADD COLUMN IF NOT EXISTS "volume" TEXT,
  ADD COLUMN IF NOT EXISTS "fluidCategory" TEXT,
  ADD COLUMN IF NOT EXISTS "agentPercent" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "clinicalEventCode" TEXT;

CREATE TABLE IF NOT EXISTS "PremedicationAdministration" (
  "id" TEXT NOT NULL,
  "intraopId" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "phase" TEXT NOT NULL,
  "drugId" TEXT,
  "nameRaw" TEXT NOT NULL,
  "inn" TEXT,
  "atcCode" TEXT,
  "dose" TEXT,
  "route" TEXT,
  "ordinal" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PremedicationAdministration_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CaseComplication" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "section" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "note" TEXT,
  "timestamp" TIMESTAMP(3),
  "source" TEXT,
  "eventId" TEXT,
  "ordinal" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CaseComplication_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CaseEvent_infId_idx" ON "CaseEvent"("infId");
CREATE INDEX IF NOT EXISTS "CaseEvent_fluidId_idx" ON "CaseEvent"("fluidId");
CREATE INDEX IF NOT EXISTS "CaseEvent_clinicalEventCode_idx" ON "CaseEvent"("clinicalEventCode");

CREATE INDEX IF NOT EXISTS "PremedicationAdministration_caseId_idx" ON "PremedicationAdministration"("caseId");
CREATE INDEX IF NOT EXISTS "PremedicationAdministration_intraopId_idx" ON "PremedicationAdministration"("intraopId");
CREATE INDEX IF NOT EXISTS "PremedicationAdministration_phase_idx" ON "PremedicationAdministration"("phase");
CREATE INDEX IF NOT EXISTS "PremedicationAdministration_atcCode_idx" ON "PremedicationAdministration"("atcCode");

CREATE INDEX IF NOT EXISTS "CaseComplication_caseId_idx" ON "CaseComplication"("caseId");
CREATE INDEX IF NOT EXISTS "CaseComplication_section_idx" ON "CaseComplication"("section");
CREATE INDEX IF NOT EXISTS "CaseComplication_label_idx" ON "CaseComplication"("label");

ALTER TABLE "PremedicationAdministration"
  ADD CONSTRAINT "PremedicationAdministration_intraopId_fkey"
  FOREIGN KEY ("intraopId") REFERENCES "IntraoperativeRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CaseComplication"
  ADD CONSTRAINT "CaseComplication_caseId_fkey"
  FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
