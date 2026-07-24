-- Add local OMOP/Athena vocabulary tables and concept-map governance fields.
-- This migration is additive and does not rewrite any previously applied migration.

ALTER TABLE "ConceptMap"
  ADD COLUMN IF NOT EXISTS "mappingMethod" TEXT,
  ADD COLUMN IF NOT EXISTS "mappingConfidence" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "reviewed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "reviewedBy" TEXT,
  ADD COLUMN IF NOT EXISTS "reviewedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "mappingNotes" TEXT,
  ADD COLUMN IF NOT EXISTS "athenaVersion" TEXT;

CREATE INDEX IF NOT EXISTS "ConceptMap_reviewed_idx" ON "ConceptMap"("reviewed");

CREATE TABLE IF NOT EXISTS "OmopVocabulary" (
  "vocabularyId" TEXT NOT NULL,
  "vocabularyName" TEXT,
  "vocabularyReference" TEXT,
  "vocabularyVersion" TEXT,
  "vocabularyConceptId" INTEGER,
  "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OmopVocabulary_pkey" PRIMARY KEY ("vocabularyId")
);

CREATE TABLE IF NOT EXISTS "OmopDomain" (
  "domainId" TEXT NOT NULL,
  "domainName" TEXT,
  "domainConceptId" INTEGER,
  CONSTRAINT "OmopDomain_pkey" PRIMARY KEY ("domainId")
);

CREATE TABLE IF NOT EXISTS "OmopConcept" (
  "conceptId" INTEGER NOT NULL,
  "conceptName" TEXT NOT NULL,
  "domainId" TEXT NOT NULL,
  "vocabularyId" TEXT NOT NULL,
  "conceptClassId" TEXT NOT NULL,
  "standardConcept" TEXT,
  "conceptCode" TEXT NOT NULL,
  "validStartDate" TIMESTAMP(3),
  "validEndDate" TIMESTAMP(3),
  "invalidReason" TEXT,
  "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OmopConcept_pkey" PRIMARY KEY ("conceptId")
);

CREATE INDEX IF NOT EXISTS "OmopConcept_vocabularyId_conceptCode_idx" ON "OmopConcept"("vocabularyId", "conceptCode");
CREATE INDEX IF NOT EXISTS "OmopConcept_domainId_idx" ON "OmopConcept"("domainId");
CREATE INDEX IF NOT EXISTS "OmopConcept_standardConcept_idx" ON "OmopConcept"("standardConcept");
CREATE INDEX IF NOT EXISTS "OmopConcept_conceptName_idx" ON "OmopConcept"("conceptName");

CREATE TABLE IF NOT EXISTS "OmopConceptRelationship" (
  "id" TEXT NOT NULL,
  "conceptId1" INTEGER NOT NULL,
  "conceptId2" INTEGER NOT NULL,
  "relationshipId" TEXT NOT NULL,
  "validStartDate" TIMESTAMP(3),
  "validEndDate" TIMESTAMP(3),
  "invalidReason" TEXT,
  "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OmopConceptRelationship_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "OmopConceptRelationship_conceptId1_conceptId2_relationshipId_key"
  ON "OmopConceptRelationship"("conceptId1", "conceptId2", "relationshipId");
CREATE INDEX IF NOT EXISTS "OmopConceptRelationship_conceptId1_relationshipId_idx"
  ON "OmopConceptRelationship"("conceptId1", "relationshipId");
CREATE INDEX IF NOT EXISTS "OmopConceptRelationship_conceptId2_relationshipId_idx"
  ON "OmopConceptRelationship"("conceptId2", "relationshipId");

CREATE TABLE IF NOT EXISTS "OmopConceptAncestor" (
  "id" TEXT NOT NULL,
  "ancestorConceptId" INTEGER NOT NULL,
  "descendantConceptId" INTEGER NOT NULL,
  "minLevelsOfSeparation" INTEGER,
  "maxLevelsOfSeparation" INTEGER,
  "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OmopConceptAncestor_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "OmopConceptAncestor_ancestorConceptId_descendantConceptId_key"
  ON "OmopConceptAncestor"("ancestorConceptId", "descendantConceptId");
CREATE INDEX IF NOT EXISTS "OmopConceptAncestor_ancestorConceptId_idx" ON "OmopConceptAncestor"("ancestorConceptId");
CREATE INDEX IF NOT EXISTS "OmopConceptAncestor_descendantConceptId_idx" ON "OmopConceptAncestor"("descendantConceptId");

CREATE TABLE IF NOT EXISTS "OmopConceptSynonym" (
  "id" TEXT NOT NULL,
  "conceptId" INTEGER NOT NULL,
  "conceptSynonymName" TEXT NOT NULL,
  "languageConceptId" INTEGER,
  "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OmopConceptSynonym_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "OmopConceptSynonym_conceptId_idx" ON "OmopConceptSynonym"("conceptId");
CREATE INDEX IF NOT EXISTS "OmopConceptSynonym_conceptSynonymName_idx" ON "OmopConceptSynonym"("conceptSynonymName");

CREATE TABLE IF NOT EXISTS "OmopVocabularyImport" (
  "id" TEXT NOT NULL,
  "sourceDirectory" TEXT NOT NULL,
  "vocabularyVersion" TEXT,
  "importedTables" JSONB NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "status" TEXT NOT NULL DEFAULT 'started',
  "error" TEXT,
  CONSTRAINT "OmopVocabularyImport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "OmopVocabularyImport_status_idx" ON "OmopVocabularyImport"("status");
CREATE INDEX IF NOT EXISTS "OmopVocabularyImport_startedAt_idx" ON "OmopVocabularyImport"("startedAt");
