-- 1.2.0 stable research case pseudonyms.
--
-- `Case.id` is an operational database key and `caseCode` is printed on the
-- clinical chart. Neither is suitable for Browser URLs, research responses, or
-- export source values. Every existing and future case therefore receives a
-- random, immutable UUID dedicated to the research boundary.

ALTER TABLE "Case" ADD COLUMN "researchId" UUID;

UPDATE "Case"
SET "researchId" = gen_random_uuid()
WHERE "researchId" IS NULL;

ALTER TABLE "Case" ALTER COLUMN "researchId" SET NOT NULL;

CREATE UNIQUE INDEX "Case_researchId_key" ON "Case"("researchId");

CREATE FUNCTION "forbid_case_research_id_change"()
RETURNS trigger AS $$
BEGIN
  IF NEW."researchId" IS DISTINCT FROM OLD."researchId" THEN
    RAISE EXCEPTION 'CASE_RESEARCH_ID_IMMUTABLE'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Case_research_id_immutable"
BEFORE UPDATE OF "researchId" ON "Case"
FOR EACH ROW EXECUTE FUNCTION "forbid_case_research_id_change"();

-- Research is an explicit, time-bounded entitlement. Query, row inspection,
-- ordinary export, OMOP export, and cohort sharing are separate permissions.
-- Existing grants keep their aggregate-query ability, gain no new sharing
-- ability, and are capped to the approved maximum lifetime.
ALTER TABLE "ResearchAccessGrant"
  ADD COLUMN "canQuery" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "canShareCohorts" BOOLEAN NOT NULL DEFAULT false;

UPDATE "ResearchAccessGrant"
SET "expiresAt" = LEAST(
  COALESCE("expiresAt", "createdAt" + INTERVAL '90 days'),
  "createdAt" + INTERVAL '365 days'
);

ALTER TABLE "ResearchAccessGrant" ALTER COLUMN "expiresAt" SET NOT NULL;
ALTER TABLE "ResearchAccessGrant" ALTER COLUMN "canInspectCases" SET DEFAULT false;

ALTER TABLE "ResearchAccessGrant"
  ADD CONSTRAINT "ResearchAccessGrant_permission_dependency_check"
  CHECK (
    "canQuery"
    AND (NOT "canExportOmop" OR "canExport")
  ),
  ADD CONSTRAINT "ResearchAccessGrant_expiry_window_check"
  CHECK (
    "expiresAt" > "createdAt"
    AND "expiresAt" <= "createdAt" + INTERVAL '365 days'
  );

CREATE TABLE "ResearchSelfAuthorization" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "institutionId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ResearchSelfAuthorization_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ResearchSelfAuthorization_duration_check"
    CHECK (
      "expiresAt" > "createdAt"
      AND "expiresAt" <= "createdAt" + INTERVAL '8 hours'
    )
);

CREATE INDEX "ResearchSelfAuthorization_userId_createdAt_idx"
  ON "ResearchSelfAuthorization"("userId", "createdAt");
CREATE INDEX "ResearchSelfAuthorization_expiresAt_idx"
  ON "ResearchSelfAuthorization"("expiresAt");

ALTER TABLE "ResearchSelfAuthorization"
  ADD CONSTRAINT "ResearchSelfAuthorization_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ResearchSelfAuthorization_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "Institution"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE FUNCTION "enforce_research_self_authorization_cooldown"()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "ResearchSelfAuthorization" prior
    WHERE prior."userId" = NEW."userId"
      AND prior."createdAt" > NEW."createdAt" - INTERVAL '24 hours'
  ) THEN
    RAISE EXCEPTION 'RESEARCH_SELF_AUTHORIZATION_COOLDOWN'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ResearchSelfAuthorization_cooldown"
BEFORE INSERT ON "ResearchSelfAuthorization"
FOR EACH ROW EXECUTE FUNCTION "enforce_research_self_authorization_cooldown"();

CREATE FUNCTION "forbid_research_self_authorization_mutation"()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'RESEARCH_SELF_AUTHORIZATION_IMMUTABLE'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ResearchSelfAuthorization_append_only"
BEFORE UPDATE OR DELETE ON "ResearchSelfAuthorization"
FOR EACH ROW EXECUTE FUNCTION "forbid_research_self_authorization_mutation"();
