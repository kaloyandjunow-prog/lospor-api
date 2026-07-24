DO $$ BEGIN
  CREATE TYPE "ConceptMappingStatus" AS ENUM ('MAPPED', 'SOURCE_ONLY', 'UNMAPPED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "ClinicalFieldPresence" AS ENUM ('PRESENT', 'ABSENT', 'UNKNOWN', 'NOT_APPLICABLE', 'NOT_DOCUMENTED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "ConceptMap" (
  "id" TEXT NOT NULL,
  "domain" TEXT NOT NULL,
  "sourceVocabulary" TEXT NOT NULL,
  "sourceCode" TEXT NOT NULL,
  "sourceLabelEn" TEXT,
  "sourceLabelBg" TEXT,
  "standardVocabulary" TEXT,
  "standardConceptId" INTEGER,
  "standardLabel" TEXT,
  "mappingStatus" "ConceptMappingStatus" NOT NULL DEFAULT 'SOURCE_ONLY',
  "sourceVersion" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ConceptMap_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ClinicalFieldStatus" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "section" TEXT NOT NULL,
  "fieldKey" TEXT NOT NULL,
  "presence" "ClinicalFieldPresence" NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'sync',
  "sourceVersion" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ClinicalFieldStatus_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ConceptMap_domain_sourceVocabulary_sourceCode_key" ON "ConceptMap"("domain", "sourceVocabulary", "sourceCode");
CREATE INDEX IF NOT EXISTS "ConceptMap_sourceVocabulary_sourceCode_idx" ON "ConceptMap"("sourceVocabulary", "sourceCode");
CREATE INDEX IF NOT EXISTS "ConceptMap_standardConceptId_idx" ON "ConceptMap"("standardConceptId");
CREATE INDEX IF NOT EXISTS "ConceptMap_mappingStatus_idx" ON "ConceptMap"("mappingStatus");

CREATE UNIQUE INDEX IF NOT EXISTS "ClinicalFieldStatus_caseId_section_fieldKey_key" ON "ClinicalFieldStatus"("caseId", "section", "fieldKey");
CREATE INDEX IF NOT EXISTS "ClinicalFieldStatus_caseId_section_idx" ON "ClinicalFieldStatus"("caseId", "section");
CREATE INDEX IF NOT EXISTS "ClinicalFieldStatus_presence_idx" ON "ClinicalFieldStatus"("presence");

ALTER TABLE "ClinicalFieldStatus"
  ADD CONSTRAINT "ClinicalFieldStatus_caseId_fkey"
  FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CaseEvent"
  ADD COLUMN IF NOT EXISTS "sourceVersion" TEXT,
  ADD COLUMN IF NOT EXISTS "schemaVersion" TEXT;

ALTER TABLE "PreopDiagnosis"
  ADD COLUMN IF NOT EXISTS "sourceVocabulary" TEXT,
  ADD COLUMN IF NOT EXISTS "sourceCode" TEXT,
  ADD COLUMN IF NOT EXISTS "standardConceptId" INTEGER,
  ADD COLUMN IF NOT EXISTS "mappingStatus" "ConceptMappingStatus" NOT NULL DEFAULT 'SOURCE_ONLY',
  ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'sync',
  ADD COLUMN IF NOT EXISTS "sourceVersion" TEXT;

ALTER TABLE "PreopProcedure"
  ADD COLUMN IF NOT EXISTS "sourceVocabulary" TEXT,
  ADD COLUMN IF NOT EXISTS "sourceCode" TEXT,
  ADD COLUMN IF NOT EXISTS "standardConceptId" INTEGER,
  ADD COLUMN IF NOT EXISTS "mappingStatus" "ConceptMappingStatus" NOT NULL DEFAULT 'SOURCE_ONLY',
  ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'sync',
  ADD COLUMN IF NOT EXISTS "sourceVersion" TEXT;

ALTER TABLE "Comorbidity"
  ADD COLUMN IF NOT EXISTS "sourceVocabulary" TEXT,
  ADD COLUMN IF NOT EXISTS "sourceCode" TEXT,
  ADD COLUMN IF NOT EXISTS "standardConceptId" INTEGER,
  ADD COLUMN IF NOT EXISTS "mappingStatus" "ConceptMappingStatus" NOT NULL DEFAULT 'SOURCE_ONLY',
  ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'sync',
  ADD COLUMN IF NOT EXISTS "sourceVersion" TEXT;

ALTER TABLE "LabResult"
  ADD COLUMN IF NOT EXISTS "sourceVocabulary" TEXT,
  ADD COLUMN IF NOT EXISTS "sourceCode" TEXT,
  ADD COLUMN IF NOT EXISTS "standardConceptId" INTEGER,
  ADD COLUMN IF NOT EXISTS "mappingStatus" "ConceptMappingStatus" NOT NULL DEFAULT 'SOURCE_ONLY',
  ADD COLUMN IF NOT EXISTS "sourceVersion" TEXT;

ALTER TABLE "Medication"
  ADD COLUMN IF NOT EXISTS "sourceVocabulary" TEXT,
  ADD COLUMN IF NOT EXISTS "sourceCode" TEXT,
  ADD COLUMN IF NOT EXISTS "standardConceptId" INTEGER,
  ADD COLUMN IF NOT EXISTS "mappingStatus" "ConceptMappingStatus" NOT NULL DEFAULT 'SOURCE_ONLY',
  ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'sync',
  ADD COLUMN IF NOT EXISTS "sourceVersion" TEXT;

ALTER TABLE "VascularAccess"
  ADD COLUMN IF NOT EXISTS "sourceVocabulary" TEXT,
  ADD COLUMN IF NOT EXISTS "sourceCode" TEXT,
  ADD COLUMN IF NOT EXISTS "standardConceptId" INTEGER,
  ADD COLUMN IF NOT EXISTS "mappingStatus" "ConceptMappingStatus" NOT NULL DEFAULT 'SOURCE_ONLY',
  ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'sync',
  ADD COLUMN IF NOT EXISTS "sourceVersion" TEXT;

ALTER TABLE "PremedicationAdministration"
  ADD COLUMN IF NOT EXISTS "sourceVocabulary" TEXT,
  ADD COLUMN IF NOT EXISTS "sourceCode" TEXT,
  ADD COLUMN IF NOT EXISTS "standardConceptId" INTEGER,
  ADD COLUMN IF NOT EXISTS "mappingStatus" "ConceptMappingStatus" NOT NULL DEFAULT 'SOURCE_ONLY',
  ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'sync',
  ADD COLUMN IF NOT EXISTS "sourceVersion" TEXT;

ALTER TABLE "CaseComplication"
  ADD COLUMN IF NOT EXISTS "sourceVocabulary" TEXT,
  ADD COLUMN IF NOT EXISTS "sourceCode" TEXT,
  ADD COLUMN IF NOT EXISTS "standardConceptId" INTEGER,
  ADD COLUMN IF NOT EXISTS "mappingStatus" "ConceptMappingStatus" NOT NULL DEFAULT 'SOURCE_ONLY',
  ADD COLUMN IF NOT EXISTS "sourceVersion" TEXT;

ALTER TABLE "CaseSelection"
  ADD COLUMN IF NOT EXISTS "sourceVocabulary" TEXT,
  ADD COLUMN IF NOT EXISTS "sourceCode" TEXT,
  ADD COLUMN IF NOT EXISTS "standardConceptId" INTEGER,
  ADD COLUMN IF NOT EXISTS "mappingStatus" "ConceptMappingStatus" NOT NULL DEFAULT 'SOURCE_ONLY',
  ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'sync',
  ADD COLUMN IF NOT EXISTS "sourceVersion" TEXT;

CREATE INDEX IF NOT EXISTS "PreopDiagnosis_sourceVocabulary_sourceCode_idx" ON "PreopDiagnosis"("sourceVocabulary", "sourceCode");
CREATE INDEX IF NOT EXISTS "PreopDiagnosis_standardConceptId_idx" ON "PreopDiagnosis"("standardConceptId");
CREATE INDEX IF NOT EXISTS "PreopProcedure_sourceVocabulary_sourceCode_idx" ON "PreopProcedure"("sourceVocabulary", "sourceCode");
CREATE INDEX IF NOT EXISTS "PreopProcedure_standardConceptId_idx" ON "PreopProcedure"("standardConceptId");
CREATE INDEX IF NOT EXISTS "Comorbidity_sourceVocabulary_sourceCode_idx" ON "Comorbidity"("sourceVocabulary", "sourceCode");
CREATE INDEX IF NOT EXISTS "Comorbidity_standardConceptId_idx" ON "Comorbidity"("standardConceptId");
CREATE INDEX IF NOT EXISTS "LabResult_sourceVocabulary_sourceCode_idx" ON "LabResult"("sourceVocabulary", "sourceCode");
CREATE INDEX IF NOT EXISTS "LabResult_standardConceptId_idx" ON "LabResult"("standardConceptId");
CREATE INDEX IF NOT EXISTS "Medication_sourceVocabulary_sourceCode_idx" ON "Medication"("sourceVocabulary", "sourceCode");
CREATE INDEX IF NOT EXISTS "Medication_standardConceptId_idx" ON "Medication"("standardConceptId");
CREATE INDEX IF NOT EXISTS "VascularAccess_sourceVocabulary_sourceCode_idx" ON "VascularAccess"("sourceVocabulary", "sourceCode");
CREATE INDEX IF NOT EXISTS "VascularAccess_standardConceptId_idx" ON "VascularAccess"("standardConceptId");
CREATE INDEX IF NOT EXISTS "PremedicationAdministration_sourceVocabulary_sourceCode_idx" ON "PremedicationAdministration"("sourceVocabulary", "sourceCode");
CREATE INDEX IF NOT EXISTS "PremedicationAdministration_standardConceptId_idx" ON "PremedicationAdministration"("standardConceptId");
CREATE INDEX IF NOT EXISTS "CaseComplication_sourceVocabulary_sourceCode_idx" ON "CaseComplication"("sourceVocabulary", "sourceCode");
CREATE INDEX IF NOT EXISTS "CaseComplication_standardConceptId_idx" ON "CaseComplication"("standardConceptId");
CREATE INDEX IF NOT EXISTS "CaseSelection_sourceVocabulary_sourceCode_idx" ON "CaseSelection"("sourceVocabulary", "sourceCode");
CREATE INDEX IF NOT EXISTS "CaseSelection_standardConceptId_idx" ON "CaseSelection"("standardConceptId");
