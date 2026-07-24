-- v2.0.0 Database Optimization migration
-- Removes ICD-11 tables, adds ICD-10 vocabulary, LOINC, ATC, Drug, Medication,
-- CaseFieldChange, CaseSnapshot, and extends LabResult/Comorbidity/CaseEvent.
-- All operations are additive except dropping the three ICD-11 tables (which held
-- only AI-translated BG labels — all test cases were wiped before this migration).

-- Drop ICD-11 tables (misnamed; Icd10BgCode actually stored ICD-11 + AI BG labels)
DROP TABLE IF EXISTS "Icd11Alias";
DROP TABLE IF EXISTS "Icd11Code";
DROP TABLE IF EXISTS "Icd10BgCode";

-- ICD-10 vocabulary
CREATE TABLE "Icd10Code" (
    "code"    TEXT NOT NULL,
    "labelEn" TEXT NOT NULL,
    "labelBg" TEXT,
    CONSTRAINT "Icd10Code_pkey" PRIMARY KEY ("code")
);

CREATE TABLE "Icd10Synonym" (
    "id"        TEXT NOT NULL,
    "icd10Code" TEXT NOT NULL,
    "synonym"   TEXT NOT NULL,
    CONSTRAINT "Icd10Synonym_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Icd10Synonym_icd10Code_idx" ON "Icd10Synonym"("icd10Code");
ALTER TABLE "Icd10Synonym" ADD CONSTRAINT "Icd10Synonym_icd10Code_fkey"
    FOREIGN KEY ("icd10Code") REFERENCES "Icd10Code"("code") ON DELETE CASCADE ON UPDATE CASCADE;

-- LOINC codes for the 67-test lab library
CREATE TABLE "LabLoinc" (
    "name"          TEXT NOT NULL,
    "loincCode"     TEXT NOT NULL,
    "unitCanon"     TEXT NOT NULL,
    "referenceLow"  DOUBLE PRECISION,
    "referenceHigh" DOUBLE PRECISION,
    CONSTRAINT "LabLoinc_pkey" PRIMARY KEY ("name")
);

-- ATC drug classification tree
CREATE TABLE "Atc" (
    "code"       TEXT NOT NULL,
    "name"       TEXT NOT NULL,
    "level"      INTEGER NOT NULL,
    "parentCode" TEXT,
    CONSTRAINT "Atc_pkey" PRIMARY KEY ("code")
);
CREATE INDEX "Atc_parentCode_idx" ON "Atc"("parentCode");
CREATE INDEX "Atc_level_idx" ON "Atc"("level");

-- Drug registry (from drugs.json)
CREATE TABLE "Drug" (
    "id"       TEXT NOT NULL,
    "name"     TEXT NOT NULL,
    "inn"      TEXT,
    "atcCode"  TEXT,
    "form"     TEXT,
    "strength" TEXT,
    CONSTRAINT "Drug_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Drug_name_idx" ON "Drug"("name");
CREATE INDEX "Drug_inn_idx"  ON "Drug"("inn");
CREATE INDEX "Drug_atcCode_idx" ON "Drug"("atcCode");

-- Medication rows (Theme C3)
CREATE TABLE "Medication" (
    "id"        TEXT NOT NULL,
    "preopId"   TEXT NOT NULL,
    "caseId"    TEXT NOT NULL,
    "drugId"    TEXT,
    "nameRaw"   TEXT NOT NULL,
    "inn"       TEXT,
    "atcCode"   TEXT,
    "dose"      TEXT,
    "route"     TEXT,
    "frequency" TEXT,
    "ordinal"   INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Medication_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Medication_caseId_idx"   ON "Medication"("caseId");
CREATE INDEX "Medication_preopId_idx"  ON "Medication"("preopId");
CREATE INDEX "Medication_atcCode_idx"  ON "Medication"("atcCode");
ALTER TABLE "Medication" ADD CONSTRAINT "Medication_preopId_fkey"
    FOREIGN KEY ("preopId") REFERENCES "PreoperativeAssessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Per-field preop/postop audit log (Theme D)
CREATE TABLE "CaseFieldChange" (
    "id"       TEXT NOT NULL,
    "caseId"   TEXT NOT NULL,
    "section"  TEXT NOT NULL,
    "field"    TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "userId"   TEXT NOT NULL,
    "at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CaseFieldChange_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CaseFieldChange_caseId_idx"         ON "CaseFieldChange"("caseId");
CREATE INDEX "CaseFieldChange_caseId_section_idx" ON "CaseFieldChange"("caseId", "section");
ALTER TABLE "CaseFieldChange" ADD CONSTRAINT "CaseFieldChange_caseId_fkey"
    FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Immutable finalization snapshot (Theme E)
CREATE TABLE "CaseSnapshot" (
    "id"            TEXT NOT NULL,
    "caseId"        TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL DEFAULT '2.0.0',
    "snapshotJson"  JSONB NOT NULL,
    "finalizedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CaseSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CaseSnapshot_caseId_key" ON "CaseSnapshot"("caseId");
ALTER TABLE "CaseSnapshot" ADD CONSTRAINT "CaseSnapshot_caseId_fkey"
    FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Extend LabResult with numeric/LOINC columns (Theme B)
ALTER TABLE "LabResult" ADD COLUMN IF NOT EXISTS "valueNum"      DOUBLE PRECISION;
ALTER TABLE "LabResult" ADD COLUMN IF NOT EXISTS "unitCanon"     TEXT;
ALTER TABLE "LabResult" ADD COLUMN IF NOT EXISTS "loincCode"     TEXT;
ALTER TABLE "LabResult" ADD COLUMN IF NOT EXISTS "referenceLow"  DOUBLE PRECISION;
ALTER TABLE "LabResult" ADD COLUMN IF NOT EXISTS "referenceHigh" DOUBLE PRECISION;
ALTER TABLE "LabResult" ADD COLUMN IF NOT EXISTS "abnormalFlag"  TEXT;
ALTER TABLE "LabResult" ADD COLUMN IF NOT EXISTS "takenAt"       TIMESTAMP(3);
ALTER TABLE "LabResult" ADD COLUMN IF NOT EXISTS "source"        TEXT;
CREATE INDEX IF NOT EXISTS "LabResult_loincCode_idx" ON "LabResult"("loincCode");

-- Extend Comorbidity with ICD-10 code (Gap 2)
ALTER TABLE "Comorbidity" ADD COLUMN IF NOT EXISTS "icd10Code" TEXT;
CREATE INDEX IF NOT EXISTS "Comorbidity_icd10Code_idx" ON "Comorbidity"("icd10Code");

-- Extend CaseEvent with ATC drug coding (Theme C4)
ALTER TABLE "CaseEvent" ADD COLUMN IF NOT EXISTS "atcCode"   TEXT;
ALTER TABLE "CaseEvent" ADD COLUMN IF NOT EXISTS "drugId"    TEXT;
ALTER TABLE "CaseEvent" ADD COLUMN IF NOT EXISTS "drugRoute" TEXT;
