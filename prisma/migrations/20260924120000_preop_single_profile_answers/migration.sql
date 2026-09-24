-- Preoperative assessment, 1.4.8: one appliance profile edited in place, one
-- answer row per case and question, and the same finalization lock the other
-- clinical tables have.
--
-- 1.4.7 versioned the profile and pinned each case to a version, with an
-- explicit "adopt" step no client ever offered. The product has one bundled
-- catalogue and one profile an operator configures; the answer rows themselves
-- record which questions were on for a case (a row, answered or NOT_ASKED)
-- and which were off (no row). Nothing here needs a version.

-- One row per case and question. A 1.4.7 database can only hold several rows
-- for one question if a case was adopted onto a newer profile; keep the newest.
DELETE FROM "PreopAssessmentAnswer" older
USING "PreopAssessmentAnswer" newer
WHERE older."preopId" = newer."preopId"
  AND older."questionId" = newer."questionId"
  AND older."profileVersion" < newer."profileVersion";

DROP INDEX IF EXISTS "PreopAssessmentAnswer_preopId_questionId_profileVersion_key";
DROP INDEX IF EXISTS "PreopAssessmentAnswer_preopId_profileVersion_idx";
CREATE UNIQUE INDEX "PreopAssessmentAnswer_preopId_questionId_key"
    ON "PreopAssessmentAnswer"("preopId", "questionId");

-- Case pinning is gone with versioning.
DROP TABLE IF EXISTS "PreopCaseProfilePin";

-- Answers and suggestions hang off the preoperative assessment, not the case,
-- so the existing guard (which reads NEW."caseId") cannot be attached as is.
-- These resolve the case through the assessment and then behave exactly like
-- lospor_guard_clinical_child_write / lospor_touch_case_from_child: lock the
-- case row, refuse any write to a finalized case, and bump clinicalRevision so
-- sync and export see the change.
CREATE OR REPLACE FUNCTION lospor_guard_preop_child_write()
RETURNS trigger AS $$
DECLARE
  target_case_id TEXT;
  parent_status TEXT;
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;

  SELECT "caseId"
  INTO target_case_id
  FROM "PreoperativeAssessment"
  WHERE "id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."preopId" ELSE NEW."preopId" END;

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

CREATE OR REPLACE FUNCTION lospor_touch_case_from_preop_child()
RETURNS trigger AS $$
DECLARE
  target_case_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;

  SELECT "caseId"
  INTO target_case_id
  FROM "PreoperativeAssessment"
  WHERE "id" = CASE WHEN TG_OP = 'DELETE' THEN OLD."preopId" ELSE NEW."preopId" END;

  UPDATE "Case"
  SET
    "clinicalRevision" = "clinicalRevision" + 1,
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = target_case_id;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PreopAssessmentAnswer_guard_case_write"
BEFORE INSERT OR UPDATE OR DELETE ON "PreopAssessmentAnswer"
FOR EACH ROW EXECUTE FUNCTION lospor_guard_preop_child_write();
CREATE TRIGGER "PreopAssessmentAnswer_touch_case_revision"
AFTER INSERT OR UPDATE OR DELETE ON "PreopAssessmentAnswer"
FOR EACH ROW EXECUTE FUNCTION lospor_touch_case_from_preop_child();

CREATE TRIGGER "PreopAssessmentSuggestion_guard_case_write"
BEFORE INSERT OR UPDATE OR DELETE ON "PreopAssessmentSuggestion"
FOR EACH ROW EXECUTE FUNCTION lospor_guard_preop_child_write();
CREATE TRIGGER "PreopAssessmentSuggestion_touch_case_revision"
AFTER INSERT OR UPDATE OR DELETE ON "PreopAssessmentSuggestion"
FOR EACH ROW EXECUTE FUNCTION lospor_touch_case_from_preop_child();
