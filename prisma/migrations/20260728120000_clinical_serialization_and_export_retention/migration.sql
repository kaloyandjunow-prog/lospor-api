ALTER TABLE "Case"
  ADD COLUMN "clinicalRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "eventRevision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "relationalRevision" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "ResearchExport"
  ADD COLUMN "revisionManifestVersion" INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN "artifactExpiresAt" TIMESTAMP(3),
  ADD COLUMN "artifactDeletedAt" TIMESTAMP(3),
  ADD COLUMN "workingArtifactKeys" JSONB;

-- Existing records were captured with the parent-updatedAt-only manifest.
UPDATE "ResearchExport"
SET "revisionManifestVersion" = 1;

-- Frozen completed artifacts remain downloadable, but receive the selected
-- 30-day retention deadline. Unfinished v1 jobs cannot be generated safely.
UPDATE "ResearchExport"
SET "artifactExpiresAt" = COALESCE("completedAt", "createdAt") + INTERVAL '30 days'
WHERE "status" = 'COMPLETE'
  AND "artifactKey" IS NOT NULL;

UPDATE "ResearchExport"
SET
  "status" = 'FAILED',
  "error" = 'Legacy revision manifest; recreate this export',
  "completedAt" = COALESCE("completedAt", CURRENT_TIMESTAMP),
  "leaseOwner" = NULL,
  "leaseExpiresAt" = NULL
WHERE "status" IN ('PENDING', 'RUNNING');

CREATE INDEX "ResearchExport_artifactExpiresAt_artifactDeletedAt_idx"
  ON "ResearchExport"("artifactExpiresAt", "artifactDeletedAt");

-- Parent fields that alter clinical meaning, ownership, lifecycle, or research
-- scope always advance the same monotonic change token used by exports.
CREATE OR REPLACE FUNCTION lospor_touch_case_parent_revision()
RETURNS trigger AS $$
BEGIN
  IF NEW."caseCode" IS DISTINCT FROM OLD."caseCode"
    OR NEW."notes" IS DISTINCT FROM OLD."notes"
    OR NEW."userId" IS DISTINCT FROM OLD."userId"
    OR NEW."institutionId" IS DISTINCT FROM OLD."institutionId"
    OR NEW."status" IS DISTINCT FROM OLD."status"
    OR NEW."finalizedAt" IS DISTINCT FROM OLD."finalizedAt"
  THEN
    NEW."clinicalRevision" := GREATEST(
      NEW."clinicalRevision",
      OLD."clinicalRevision" + 1
    );
    NEW."updatedAt" := CURRENT_TIMESTAMP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Case_touch_clinical_revision"
BEFORE UPDATE OF "caseCode", "notes", "userId", "institutionId", "status", "finalizedAt"
ON "Case"
FOR EACH ROW
EXECUTE FUNCTION lospor_touch_case_parent_revision();

-- Every authoritative child mutation first locks the parent row. Finalization
-- and clinical writes therefore serialize even when a caller bypasses the API.
CREATE OR REPLACE FUNCTION lospor_guard_clinical_child_write()
RETURNS trigger AS $$
DECLARE
  target_case_id TEXT;
  parent_status TEXT;
BEGIN
  -- Foreign-key cascade deletion is controlled by the already-locked parent.
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;

  target_case_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."caseId" ELSE NEW."caseId" END;

  SELECT "status"::TEXT
  INTO parent_status
  FROM "Case"
  WHERE "id" = target_case_id
  FOR UPDATE;

  IF parent_status = 'COMPLETE' THEN
    RAISE EXCEPTION 'CASE_FINALIZED' USING ERRCODE = 'P0001';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION lospor_touch_case_from_child()
RETURNS trigger AS $$
DECLARE
  target_case_id TEXT;
  event_increment INTEGER;
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;

  target_case_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."caseId" ELSE NEW."caseId" END;
  event_increment := CASE WHEN TG_TABLE_NAME = 'CaseEvent' THEN 1 ELSE 0 END;

  UPDATE "Case"
  SET
    "clinicalRevision" = "clinicalRevision" + 1,
    "eventRevision" = "eventRevision" + event_increment,
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = target_case_id;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PreoperativeAssessment_guard_case_write"
BEFORE INSERT OR UPDATE OR DELETE ON "PreoperativeAssessment"
FOR EACH ROW EXECUTE FUNCTION lospor_guard_clinical_child_write();
CREATE TRIGGER "PreoperativeAssessment_touch_case_revision"
AFTER INSERT OR UPDATE OR DELETE ON "PreoperativeAssessment"
FOR EACH ROW EXECUTE FUNCTION lospor_touch_case_from_child();

CREATE TRIGGER "IntraoperativeRecord_guard_case_write"
BEFORE INSERT OR UPDATE OR DELETE ON "IntraoperativeRecord"
FOR EACH ROW EXECUTE FUNCTION lospor_guard_clinical_child_write();
CREATE TRIGGER "IntraoperativeRecord_touch_case_revision"
AFTER INSERT OR UPDATE OR DELETE ON "IntraoperativeRecord"
FOR EACH ROW EXECUTE FUNCTION lospor_touch_case_from_child();

CREATE TRIGGER "PostoperativeRecord_guard_case_write"
BEFORE INSERT OR UPDATE OR DELETE ON "PostoperativeRecord"
FOR EACH ROW EXECUTE FUNCTION lospor_guard_clinical_child_write();
CREATE TRIGGER "PostoperativeRecord_touch_case_revision"
AFTER INSERT OR UPDATE OR DELETE ON "PostoperativeRecord"
FOR EACH ROW EXECUTE FUNCTION lospor_touch_case_from_child();

CREATE TRIGGER "CaseEvent_guard_case_write"
BEFORE INSERT OR UPDATE OR DELETE ON "CaseEvent"
FOR EACH ROW EXECUTE FUNCTION lospor_guard_clinical_child_write();
CREATE TRIGGER "CaseEvent_touch_case_revision"
AFTER INSERT OR UPDATE OR DELETE ON "CaseEvent"
FOR EACH ROW EXECUTE FUNCTION lospor_touch_case_from_child();
