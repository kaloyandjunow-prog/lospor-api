ALTER TABLE "PreoperativeAssessment"
  ADD CONSTRAINT "PreoperativeAssessment_ageValue_check"
    CHECK ("ageValue" IS NULL OR "ageValue" >= 0),
  ADD CONSTRAINT "PreoperativeAssessment_povocScore_check"
    CHECK ("povocScore" IS NULL OR "povocScore" BETWEEN 0 AND 4),
  ADD CONSTRAINT "PreoperativeAssessment_coldsScore_check"
    CHECK ("coldsScore" IS NULL OR "coldsScore" BETWEEN 5 AND 25);

ALTER TABLE "PostoperativeRecord"
  ADD CONSTRAINT "PostoperativeRecord_pediatricPainScore_check"
    CHECK ("pediatricPainScore" IS NULL OR "pediatricPainScore" BETWEEN 0 AND 10),
  ADD CONSTRAINT "PostoperativeRecord_paedScore_check"
    CHECK ("paedScore" IS NULL OR "paedScore" BETWEEN 0 AND 20);

CREATE OR REPLACE FUNCTION lospor_touch_case_parent_revision()
RETURNS trigger AS $$
BEGIN
  IF NEW."caseCode" IS DISTINCT FROM OLD."caseCode"
    OR NEW."notes" IS DISTINCT FROM OLD."notes"
    OR NEW."userId" IS DISTINCT FROM OLD."userId"
    OR NEW."institutionId" IS DISTINCT FROM OLD."institutionId"
    OR NEW."status" IS DISTINCT FROM OLD."status"
    OR NEW."finalizedAt" IS DISTINCT FROM OLD."finalizedAt"
    OR NEW."clinicalMode" IS DISTINCT FROM OLD."clinicalMode"
    OR NEW."clinicalRulesVersion" IS DISTINCT FROM OLD."clinicalRulesVersion"
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
