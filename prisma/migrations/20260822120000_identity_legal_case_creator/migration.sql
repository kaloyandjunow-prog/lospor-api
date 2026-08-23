-- 1.2.0 shared identity, legal evidence, and immutable case authorship.
--
-- This migration deliberately does not fabricate LegalAcceptance rows from
-- User.acceptedTermsAt/acceptedPrivacyAt. Those legacy columns do not say what
-- language or exact bytes were shown, which deployment supplied them, or even
-- which privacy-policy version was accepted. Existing accounts must accept the
-- configured exact documents once after rollout; precise absence is safer than
-- invented consent evidence.

-- Hospital 1.2 can provision research-only accounts before this shared
-- migration is deliberately imported. Its overlay creates the identical enum
-- and column, so keep this owner migration safe in either ordering without
-- treating the Hospital repository as the schema owner.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AccountKind') THEN
    CREATE TYPE "AccountKind" AS ENUM ('CLINICAL', 'RESEARCH_ONLY');
  END IF;
END $$;
CREATE TYPE "LegalDocumentKind" AS ENUM ('TERMS', 'PRIVACY');
CREATE TYPE "LegalDocumentLocale" AS ENUM ('BG', 'EN');

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "accountKind" "AccountKind" NOT NULL DEFAULT 'CLINICAL';

-- Preserve the intent of the old role without continuing to couple application
-- audience to RBAC. The role remains for compatibility; accountKind becomes the
-- authority that blocks clinical routes.
UPDATE "User"
SET "accountKind" = 'RESEARCH_ONLY'
WHERE "role" = 'RESEARCHER';

-- `preferences.ui.locale` is the only post-login locale authority. Normalize
-- invalid/missing values to Bulgarian while preserving every unrelated key.
UPDATE "User"
SET "preferences" = jsonb_set(
  CASE
    WHEN jsonb_typeof("preferences") = 'object' THEN "preferences"
    ELSE '{}'::jsonb
  END,
  '{ui}',
  (
    CASE
      WHEN jsonb_typeof("preferences"->'ui') = 'object' THEN "preferences"->'ui'
      ELSE '{}'::jsonb
    END
  ) || jsonb_build_object(
    'locale',
    CASE
      WHEN lower("preferences" #>> '{ui,locale}') = 'en' THEN 'en'
      ELSE 'bg'
    END
  ),
  true
);

ALTER TABLE "User"
  ALTER COLUMN "preferences" SET DEFAULT '{"ui":{"locale":"bg"}}'::jsonb;

CREATE TABLE "LegalAcceptance" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "deployment" TEXT NOT NULL,
  "kind" "LegalDocumentKind" NOT NULL,
  "documentVersion" TEXT NOT NULL,
  "documentEffectiveAt" DATE NOT NULL,
  "locale" "LegalDocumentLocale" NOT NULL,
  "contentSha256" TEXT NOT NULL,
  "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "LegalAcceptance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LegalAcceptance_contentSha256_check"
    CHECK ("contentSha256" ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX "LegalAcceptance_exact_acceptance_key"
  ON "LegalAcceptance" (
    "userId", "deployment", "kind", "documentVersion",
    "documentEffectiveAt", "locale", "contentSha256"
  );
CREATE INDEX "LegalAcceptance_userId_kind_acceptedAt_idx"
  ON "LegalAcceptance" ("userId", "kind", "acceptedAt");

ALTER TABLE "LegalAcceptance"
  ADD CONSTRAINT "LegalAcceptance_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "forbid_legal_acceptance_mutation"()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'LEGAL_ACCEPTANCE_IMMUTABLE'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LegalAcceptance_append_only"
BEFORE UPDATE OR DELETE ON "LegalAcceptance"
FOR EACH ROW EXECUTE FUNCTION "forbid_legal_acceptance_mutation"();

-- Add authorship nullable, infer the earliest known holder, then make it
-- mandatory. An accepted transfer is direct evidence that its fromUser held
-- the case before the current assignee. With no accepted transfer, current
-- assignee is the only evidence available and therefore the conservative
-- author attribution.
ALTER TABLE "Case" ADD COLUMN "createdById" TEXT;

UPDATE "Case" AS c
SET "createdById" = COALESCE(
  (
    SELECT t."fromUserId"
    FROM "CaseTransfer" AS t
    WHERE t."caseId" = c."id"
      AND t."status" = 'ACCEPTED'
    ORDER BY COALESCE(t."resolvedAt", t."createdAt") ASC,
             t."createdAt" ASC,
             t."id" ASC
    LIMIT 1
  ),
  c."userId"
);

ALTER TABLE "Case" ALTER COLUMN "createdById" SET NOT NULL;
CREATE INDEX "Case_createdById_createdAt_idx" ON "Case" ("createdById", "createdAt");

-- A transfer could free the old `(userId, clientDraftId)` key and let an old
-- client reuse the same draft id for a second case by the original creator.
-- Do not delete or merge either clinical record. Retain the idempotency link on
-- the earliest case and clear only the later duplicate technical keys before
-- moving uniqueness to immutable creator scope.
WITH ranked_creator_drafts AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "createdById", "clientDraftId"
      ORDER BY "createdAt" ASC, "id" ASC
    ) AS occurrence
  FROM "Case"
  WHERE "clientDraftId" IS NOT NULL
)
UPDATE "Case" AS c
SET "clientDraftId" = NULL
FROM ranked_creator_drafts AS ranked
WHERE ranked."id" = c."id"
  AND ranked.occurrence > 1;

DROP INDEX "Case_userId_clientDraftId_key";
CREATE UNIQUE INDEX "Case_createdById_clientDraftId_key"
  ON "Case" ("createdById", "clientDraftId");
ALTER TABLE "Case"
  ADD CONSTRAINT "Case_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "forbid_case_creator_change"()
RETURNS trigger AS $$
BEGIN
  IF NEW."createdById" IS DISTINCT FROM OLD."createdById" THEN
    RAISE EXCEPTION 'CASE_CREATOR_IMMUTABLE'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Case_creator_immutable"
BEFORE UPDATE OF "createdById" ON "Case"
FOR EACH ROW EXECUTE FUNCTION "forbid_case_creator_change"();

-- Public registration no longer has an administrator approval state. Email
-- verification is the activation gate; role and institution changes remain
-- separately governed.
ALTER TABLE "User" DROP COLUMN IF EXISTS "approvedAt";
