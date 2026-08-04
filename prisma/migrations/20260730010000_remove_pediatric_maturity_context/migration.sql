ALTER TABLE "PreoperativeAssessment"
  DROP CONSTRAINT IF EXISTS "PreoperativeAssessment_gestationalAgeAtBirthDays_check",
  DROP CONSTRAINT IF EXISTS "PreoperativeAssessment_postmenstrualAgeAtCaseDays_check",
  DROP CONSTRAINT IF EXISTS "PreoperativeAssessment_maturityCalculationVersion_check";

ALTER TABLE "PreoperativeAssessment"
  DROP COLUMN IF EXISTS "prematurityStatus",
  DROP COLUMN IF EXISTS "gestationalAgeAtBirthDays",
  DROP COLUMN IF EXISTS "postmenstrualAgeAtCaseDays",
  DROP COLUMN IF EXISTS "maturityCalculationVersion",
  DROP COLUMN IF EXISTS "gestationalAgeWeeks",
  DROP COLUMN IF EXISTS "postmenstrualAgeWeeks";

DROP TYPE IF EXISTS "PrematurityStatus";