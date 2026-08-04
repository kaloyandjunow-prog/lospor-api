CREATE TYPE "ClinicalPresetStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');

CREATE TABLE "ClinicalPreset" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "version" INTEGER NOT NULL,
    "status" "ClinicalPresetStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" TEXT,
    "publishedById" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ClinicalPreset_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ClinicalPresetRule" (
    "id" TEXT NOT NULL,
    "presetId" TEXT NOT NULL,
    "ruleKey" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "sourceRefs" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ClinicalPresetRule_pkey" PRIMARY KEY ("id")
);

INSERT INTO "ClinicalPreset" (
    "id",
    "key",
    "name",
    "description",
    "version",
    "status",
    "publishedAt",
    "updatedAt"
) VALUES (
    'lospor-standard-v1',
    'LOSPOR_STANDARD',
    'LOSPOR Standard',
    'Platform-managed baseline clinical preset.',
    1,
    'PUBLISHED',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
);

ALTER TABLE "Institution"
ADD COLUMN "clinicalPresetId" TEXT;

UPDATE "Institution"
SET "clinicalPresetId" = 'lospor-standard-v1'
WHERE "clinicalPresetId" IS NULL;

ALTER TABLE "Institution"
ALTER COLUMN "clinicalPresetId" SET NOT NULL,
ALTER COLUMN "clinicalPresetId" SET DEFAULT 'lospor-standard-v1';

ALTER TABLE "InstitutionClinicalRuleOverride"
ADD COLUMN "presetId" TEXT,
ADD COLUMN "proposedById" TEXT;

UPDATE "InstitutionClinicalRuleOverride"
SET "presetId" = 'lospor-standard-v1'
WHERE "presetId" IS NULL;

ALTER TABLE "InstitutionClinicalRuleOverride"
ALTER COLUMN "presetId" SET NOT NULL;

DROP INDEX IF EXISTS "InstitutionClinicalRuleOverride_institutionId_ruleKey_overrideVersion_key";

CREATE UNIQUE INDEX "ClinicalPreset_key_version_key"
ON "ClinicalPreset"("key", "version");

CREATE INDEX "ClinicalPreset_status_idx"
ON "ClinicalPreset"("status");

CREATE UNIQUE INDEX "ClinicalPresetRule_presetId_ruleKey_key"
ON "ClinicalPresetRule"("presetId", "ruleKey");

CREATE INDEX "ClinicalPresetRule_presetId_idx"
ON "ClinicalPresetRule"("presetId");

CREATE UNIQUE INDEX "InstitutionClinicalRuleOverride_institutionId_presetId_ruleKey_overrideVersion_key"
ON "InstitutionClinicalRuleOverride"("institutionId", "presetId", "ruleKey", "overrideVersion");

CREATE INDEX "InstitutionClinicalRuleOverride_presetId_idx"
ON "InstitutionClinicalRuleOverride"("presetId");

ALTER TABLE "ClinicalPreset"
ADD CONSTRAINT "ClinicalPreset_createdById_fkey"
FOREIGN KEY ("createdById") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ClinicalPreset"
ADD CONSTRAINT "ClinicalPreset_publishedById_fkey"
FOREIGN KEY ("publishedById") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ClinicalPresetRule"
ADD CONSTRAINT "ClinicalPresetRule_presetId_fkey"
FOREIGN KEY ("presetId") REFERENCES "ClinicalPreset"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Institution"
ADD CONSTRAINT "Institution_clinicalPresetId_fkey"
FOREIGN KEY ("clinicalPresetId") REFERENCES "ClinicalPreset"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InstitutionClinicalRuleOverride"
ADD CONSTRAINT "InstitutionClinicalRuleOverride_presetId_fkey"
FOREIGN KEY ("presetId") REFERENCES "ClinicalPreset"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InstitutionClinicalRuleOverride"
ADD CONSTRAINT "InstitutionClinicalRuleOverride_proposedById_fkey"
FOREIGN KEY ("proposedById") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
