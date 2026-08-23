-- Exact, immutable publication evidence for clinical rulesets.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE "ClinicalRulesetPublicationEvidence" (
    "id" TEXT NOT NULL,
    "presetId" TEXT NOT NULL,
    "baselinePresetId" TEXT,
    "baselinePresetVersion" INTEGER,
    "reason" TEXT,
    "contentSha256" TEXT NOT NULL,
    "diffSha256" TEXT NOT NULL,
    "exactDiff" JSONB NOT NULL,
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClinicalRulesetPublicationEvidence_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ClinicalRulesetPublicationEvidence_contentSha256_check"
      CHECK ("contentSha256" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT "ClinicalRulesetPublicationEvidence_diffSha256_check"
      CHECK ("diffSha256" ~ '^[a-f0-9]{64}$'),
    CONSTRAINT "ClinicalRulesetPublicationEvidence_baseline_version_check"
      CHECK ("baselinePresetVersion" IS NULL OR "baselinePresetVersion" > 0)
);

CREATE UNIQUE INDEX "ClinicalRulesetPublicationEvidence_presetId_key"
  ON "ClinicalRulesetPublicationEvidence"("presetId");
CREATE INDEX "ClinicalRulesetPublicationEvidence_baselinePresetId_idx"
  ON "ClinicalRulesetPublicationEvidence"("baselinePresetId");
CREATE INDEX "ClinicalRulesetPublicationEvidence_confirmedById_confirmedAt_idx"
  ON "ClinicalRulesetPublicationEvidence"("confirmedById", "confirmedAt");

ALTER TABLE "ClinicalRulesetPublicationEvidence"
  ADD CONSTRAINT "ClinicalRulesetPublicationEvidence_presetId_fkey"
  FOREIGN KEY ("presetId") REFERENCES "ClinicalPreset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ClinicalRulesetPublicationEvidence"
  ADD CONSTRAINT "ClinicalRulesetPublicationEvidence_confirmedById_fkey"
  FOREIGN KEY ("confirmedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Existing published presets predate the application evidence contract. Keep
-- them selectable after upgrade with a clearly marked, deterministic legacy
-- snapshot. New publications use schemaVersion 1 exact before/after evidence.
WITH published_content AS (
  SELECT
    preset."id" AS preset_id,
    preset."copiedFromPresetId" AS baseline_id,
    source."version" AS baseline_version,
    preset."scope" AS preset_scope,
    preset."publishedById" AS publisher_id,
    COALESCE(preset."publishedAt", preset."updatedAt") AS confirmed_at,
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'ruleKey', rule."ruleKey",
          'ruleVersion', rule."ruleVersion",
          'payload', rule."payload",
          'sourceRefs', rule."sourceRefs"
        ) ORDER BY rule."ruleKey"
      ) FILTER (WHERE rule."id" IS NOT NULL),
      '[]'::jsonb
    ) AS content
  FROM "ClinicalPreset" preset
  LEFT JOIN "ClinicalPreset" source ON source."id" = preset."copiedFromPresetId"
  LEFT JOIN "ClinicalPresetRule" rule ON rule."presetId" = preset."id"
  WHERE preset."status" IN ('PUBLISHED', 'RETIRED')
  GROUP BY preset."id", source."version"
), legacy_evidence AS (
  SELECT
    *,
    jsonb_build_object(
      'schemaVersion', 0,
      'provenance', 'MIGRATION_BACKFILL',
      'baselinePresetId', baseline_id,
      'baselinePresetVersion', baseline_version,
      'publishedContent', content
    ) AS exact_diff
  FROM published_content
)
INSERT INTO "ClinicalRulesetPublicationEvidence" (
  "id", "presetId", "baselinePresetId", "baselinePresetVersion", "reason",
  "contentSha256", "diffSha256", "exactDiff", "confirmedById", "confirmedAt"
)
SELECT
  'clinical-publication-backfill-' || encode(digest(convert_to(preset_id, 'UTF8'), 'sha256'), 'hex'),
  preset_id,
  baseline_id,
  baseline_version,
  CASE WHEN preset_scope = 'INSTITUTION'
    THEN 'Migrated pre-1.2.0 publication evidence'
    ELSE NULL
  END,
  encode(digest(convert_to(content::text, 'UTF8'), 'sha256'), 'hex'),
  encode(digest(convert_to(exact_diff::text, 'UTF8'), 'sha256'), 'hex'),
  exact_diff,
  publisher_id,
  confirmed_at
FROM legacy_evidence;

-- Evidence is append-only. Corrections require a new ruleset version and a new
-- evidence row rather than rewriting what was approved previously.
CREATE OR REPLACE FUNCTION reject_clinical_rules_publication_evidence_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'clinical rules publication evidence is immutable';
END;
$$;

CREATE TRIGGER "ClinicalRulesetPublicationEvidence_append_only"
BEFORE UPDATE OR DELETE ON "ClinicalRulesetPublicationEvidence"
FOR EACH ROW EXECUTE FUNCTION reject_clinical_rules_publication_evidence_mutation();

-- An institution publication must bind a meaningful HOD reason and a concrete
-- platform baseline. This is enforced below the API as well as in it.
CREATE OR REPLACE FUNCTION validate_clinical_rules_publication_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  preset_scope "ClinicalPresetScope";
BEGIN
  SELECT "scope" INTO preset_scope FROM "ClinicalPreset" WHERE "id" = NEW."presetId";
  IF preset_scope = 'INSTITUTION' THEN
    IF NEW."baselinePresetId" IS NULL OR NEW."baselinePresetVersion" IS NULL THEN
      RAISE EXCEPTION 'institution publication requires a platform baseline';
    END IF;
    IF NEW."reason" IS NULL OR char_length(btrim(NEW."reason")) < 10 THEN
      RAISE EXCEPTION 'institution publication requires a reason of at least 10 characters';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ClinicalRulesetPublicationEvidence_validate"
BEFORE INSERT ON "ClinicalRulesetPublicationEvidence"
FOR EACH ROW EXECUTE FUNCTION validate_clinical_rules_publication_evidence();

-- Once published, rule rows cannot be edited or removed, even by a direct SQL
-- caller. Draft copying is the only supported way to make a new version.
CREATE OR REPLACE FUNCTION reject_published_clinical_rule_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_preset_id TEXT;
  target_status "ClinicalPresetStatus";
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_preset_id := OLD."presetId";
  ELSE
    target_preset_id := NEW."presetId";
  END IF;
  SELECT "status" INTO target_status FROM "ClinicalPreset" WHERE "id" = target_preset_id;
  IF target_status <> 'DRAFT' THEN
    RAISE EXCEPTION 'published clinical rules are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ClinicalPresetRule_published_immutable"
BEFORE INSERT OR UPDATE OR DELETE ON "ClinicalPresetRule"
FOR EACH ROW EXECUTE FUNCTION reject_published_clinical_rule_mutation();

-- Published preset metadata and ownership are immutable. Retirement is a
-- state transition, not a rewrite, and remains possible.
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
      OR NEW."publishedAt" IS DISTINCT FROM OLD."publishedAt"
      OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
      OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
      OR NEW."status" NOT IN ('PUBLISHED', 'RETIRED')
    THEN
      RAISE EXCEPTION 'published clinical ruleset metadata is immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ClinicalPreset_published_immutable"
BEFORE INSERT OR UPDATE ON "ClinicalPreset"
FOR EACH ROW EXECUTE FUNCTION protect_published_clinical_preset();
