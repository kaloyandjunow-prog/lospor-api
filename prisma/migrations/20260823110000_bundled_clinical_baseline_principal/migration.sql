-- LOSPOR release identities author immutable bundled clinical baselines without
-- becoming login-capable User rows. This table deliberately has no email,
-- password, role, MFA, token or AuthSession relation.
CREATE TYPE "TechnicalPrincipalKind" AS ENUM ('RELEASE');

CREATE TABLE "TechnicalPrincipal" (
    "id" TEXT NOT NULL,
    "kind" "TechnicalPrincipalKind" NOT NULL,
    "displayName" TEXT NOT NULL,
    "releaseVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TechnicalPrincipal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TechnicalPrincipal_kind_releaseVersion_key"
  ON "TechnicalPrincipal"("kind", "releaseVersion");

ALTER TABLE "ClinicalPreset"
  ADD COLUMN "createdByTechnicalPrincipalId" TEXT,
  ADD COLUMN "publishedByTechnicalPrincipalId" TEXT;

ALTER TABLE "ClinicalRulesetPublicationEvidence"
  ADD COLUMN "confirmedByTechnicalPrincipalId" TEXT;

ALTER TABLE "PlatformClinicalPresetSelection"
  ADD COLUMN "selectedByTechnicalPrincipalId" TEXT;

ALTER TABLE "ClinicalPreset"
  ADD CONSTRAINT "ClinicalPreset_creator_principal_xor"
  CHECK (NOT ("createdById" IS NOT NULL AND "createdByTechnicalPrincipalId" IS NOT NULL)),
  ADD CONSTRAINT "ClinicalPreset_publisher_principal_xor"
  CHECK (NOT ("publishedById" IS NOT NULL AND "publishedByTechnicalPrincipalId" IS NOT NULL));

ALTER TABLE "ClinicalRulesetPublicationEvidence"
  ADD CONSTRAINT "ClinicalRulesetPublicationEvidence_confirmer_principal_xor"
  CHECK (NOT ("confirmedById" IS NOT NULL AND "confirmedByTechnicalPrincipalId" IS NOT NULL));

ALTER TABLE "PlatformClinicalPresetSelection"
  ADD CONSTRAINT "PlatformClinicalPresetSelection_selector_principal_xor"
  CHECK (NOT ("selectedById" IS NOT NULL AND "selectedByTechnicalPrincipalId" IS NOT NULL));

CREATE INDEX "ClinicalPreset_createdByTechnicalPrincipalId_idx"
  ON "ClinicalPreset"("createdByTechnicalPrincipalId");
CREATE INDEX "ClinicalPreset_publishedByTechnicalPrincipalId_idx"
  ON "ClinicalPreset"("publishedByTechnicalPrincipalId");
CREATE INDEX "ClinicalRulesetPublicationEvidence_confirmedByTechnicalPrincipalId_confirmedAt_idx"
  ON "ClinicalRulesetPublicationEvidence"("confirmedByTechnicalPrincipalId", "confirmedAt");
CREATE INDEX "PlatformClinicalPresetSelection_selectedByTechnicalPrincipalId_idx"
  ON "PlatformClinicalPresetSelection"("selectedByTechnicalPrincipalId");

ALTER TABLE "ClinicalPreset"
  ADD CONSTRAINT "ClinicalPreset_createdByTechnicalPrincipalId_fkey"
  FOREIGN KEY ("createdByTechnicalPrincipalId") REFERENCES "TechnicalPrincipal"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "ClinicalPreset_publishedByTechnicalPrincipalId_fkey"
  FOREIGN KEY ("publishedByTechnicalPrincipalId") REFERENCES "TechnicalPrincipal"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ClinicalRulesetPublicationEvidence"
  ADD CONSTRAINT "ClinicalRulesetPublicationEvidence_confirmedByTechnicalPrincipalId_fkey"
  FOREIGN KEY ("confirmedByTechnicalPrincipalId") REFERENCES "TechnicalPrincipal"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PlatformClinicalPresetSelection"
  ADD CONSTRAINT "PlatformClinicalPresetSelection_selectedByTechnicalPrincipalId_fkey"
  FOREIGN KEY ("selectedByTechnicalPrincipalId") REFERENCES "TechnicalPrincipal"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- A release identity is evidence, not an editable service account. Superseding
-- a release requires a new TechnicalPrincipal row for the new release version.
CREATE OR REPLACE FUNCTION reject_technical_principal_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'technical principals are immutable';
END;
$$;

CREATE TRIGGER "TechnicalPrincipal_immutable"
BEFORE UPDATE OR DELETE ON "TechnicalPrincipal"
FOR EACH ROW EXECUTE FUNCTION reject_technical_principal_mutation();

-- The publication-evidence migration created this trigger before technical
-- authorship existed. Replace its function so the new identity columns are
-- protected by the same database-level immutability contract as human
-- attribution. The INSERT and DRAFT -> PUBLISHED checks are intentionally
-- retained verbatim.
CREATE OR REPLACE FUNCTION protect_published_clinical_preset()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION 'clinical rulesets must be created as drafts before publication';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" = 'DRAFT' AND NEW."status" = 'PUBLISHED' AND NOT EXISTS (
    SELECT 1 FROM "ClinicalRulesetPublicationEvidence" evidence
    WHERE evidence."presetId" = OLD."id"
  ) THEN
    RAISE EXCEPTION 'clinical ruleset publication evidence is required';
  END IF;
  IF OLD."status" <> 'DRAFT' THEN
    IF NEW."key" IS DISTINCT FROM OLD."key"
      OR NEW."name" IS DISTINCT FROM OLD."name"
      OR NEW."description" IS DISTINCT FROM OLD."description"
      OR NEW."clinicalMode" IS DISTINCT FROM OLD."clinicalMode"
      OR NEW."scope" IS DISTINCT FROM OLD."scope"
      OR NEW."ownerInstitutionId" IS DISTINCT FROM OLD."ownerInstitutionId"
      OR NEW."ownerUserId" IS DISTINCT FROM OLD."ownerUserId"
      OR NEW."copiedFromPresetId" IS DISTINCT FROM OLD."copiedFromPresetId"
      OR NEW."copiedFromVersion" IS DISTINCT FROM OLD."copiedFromVersion"
      OR NEW."version" IS DISTINCT FROM OLD."version"
      OR NEW."publishedById" IS DISTINCT FROM OLD."publishedById"
      OR NEW."publishedByTechnicalPrincipalId" IS DISTINCT FROM OLD."publishedByTechnicalPrincipalId"
      OR NEW."publishedAt" IS DISTINCT FROM OLD."publishedAt"
      OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
      OR NEW."createdByTechnicalPrincipalId" IS DISTINCT FROM OLD."createdByTechnicalPrincipalId"
      OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
      OR NEW."status" NOT IN ('PUBLISHED', 'RETIRED')
    THEN
      RAISE EXCEPTION 'published clinical ruleset metadata is immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
