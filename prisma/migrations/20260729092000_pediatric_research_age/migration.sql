ALTER TABLE "PreoperativeAssessment"
  ADD COLUMN "ageApproxDays" DOUBLE PRECISION;

ALTER TABLE "PreoperativeAssessment"
  ADD CONSTRAINT "PreoperativeAssessment_ageApproxDays_check"
    CHECK ("ageApproxDays" IS NULL OR "ageApproxDays" >= 0);
