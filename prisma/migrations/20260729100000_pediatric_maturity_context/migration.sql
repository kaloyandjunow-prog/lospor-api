CREATE TYPE "PrematurityStatus" AS ENUM ('TERM', 'PRETERM', 'UNKNOWN');

ALTER TABLE "PreoperativeAssessment"
  ADD COLUMN "prematurityStatus" "PrematurityStatus",
  ADD COLUMN "gestationalAgeAtBirthDays" INTEGER,
  ADD COLUMN "postmenstrualAgeAtCaseDays" INTEGER,
  ADD COLUMN "maturityCalculationVersion" TEXT;

-- Backfill only mutable early-v8 drafts. Finalized cases remain immutable and
-- keep their compatibility fields; production has never accepted v8 writes.
UPDATE "PreoperativeAssessment" AS preop
SET
  "prematurityStatus" = CASE
    WHEN preop."gestationalAgeWeeks" IS NOT NULL
      AND preop."gestationalAgeWeeks" < 37
      THEN 'PRETERM'::"PrematurityStatus"
    WHEN preop."gestationalAgeWeeks" IS NOT NULL
      AND preop."gestationalAgeWeeks" >= 37
      THEN 'TERM'::"PrematurityStatus"
    ELSE NULL
  END,
  "gestationalAgeAtBirthDays" = CASE
    WHEN preop."gestationalAgeWeeks" IS NOT NULL
      AND preop."gestationalAgeWeeks" < 37
      THEN ROUND(preop."gestationalAgeWeeks" * 7)::INTEGER
    ELSE NULL
  END,
  "postmenstrualAgeAtCaseDays" = CASE
    WHEN
      preop."gestationalAgeWeeks" IS NOT NULL
      AND preop."gestationalAgeWeeks" < 37
      AND preop."ageApproxDays" IS NOT NULL
      THEN ROUND(
        (preop."gestationalAgeWeeks" * 7) + preop."ageApproxDays"
      )::INTEGER
    ELSE NULL
  END,
  "maturityCalculationVersion" = CASE
    WHEN
      preop."gestationalAgeWeeks" IS NOT NULL
      AND preop."gestationalAgeWeeks" < 37
      AND preop."ageApproxDays" IS NOT NULL
      THEN '1'
    ELSE NULL
  END
FROM "Case" AS parent
WHERE
  parent."id" = preop."caseId"
  AND parent."status" <> 'COMPLETE'::"CaseStatus"
  AND (
    preop."gestationalAgeWeeks" IS NOT NULL
    OR preop."postmenstrualAgeWeeks" IS NOT NULL
  );

-- A legacy manually entered PMA without enough source data remains preserved
-- in the compatibility column only. Canonical PMA must be reproducible.
UPDATE "PreoperativeAssessment" AS preop
SET
  "postmenstrualAgeAtCaseDays" = NULL,
  "maturityCalculationVersion" = NULL
FROM "Case" AS parent
WHERE
  parent."id" = preop."caseId"
  AND parent."status" <> 'COMPLETE'::"CaseStatus"
  AND preop."postmenstrualAgeAtCaseDays" IS NOT NULL
  AND (
    preop."prematurityStatus" IS DISTINCT FROM 'PRETERM'::"PrematurityStatus"
    OR preop."gestationalAgeAtBirthDays" IS NULL
  );

ALTER TABLE "PreoperativeAssessment"
  ADD CONSTRAINT "PreoperativeAssessment_gestationalAgeAtBirthDays_check"
    CHECK (
      "gestationalAgeAtBirthDays" IS NULL
      OR (
        "gestationalAgeAtBirthDays" BETWEEN 1 AND 420
        AND "prematurityStatus" = 'PRETERM'::"PrematurityStatus"
      )
    ),
  ADD CONSTRAINT "PreoperativeAssessment_postmenstrualAgeAtCaseDays_check"
    CHECK (
      "postmenstrualAgeAtCaseDays" IS NULL
      OR (
        "prematurityStatus" = 'PRETERM'::"PrematurityStatus"
        AND "gestationalAgeAtBirthDays" IS NOT NULL
        AND "postmenstrualAgeAtCaseDays" >= "gestationalAgeAtBirthDays"
      )
    ),
  ADD CONSTRAINT "PreoperativeAssessment_maturityCalculationVersion_check"
    CHECK (
      (
        "postmenstrualAgeAtCaseDays" IS NULL
        AND "maturityCalculationVersion" IS NULL
      )
      OR (
        "postmenstrualAgeAtCaseDays" IS NOT NULL
        AND "maturityCalculationVersion" IS NOT NULL
      )
    );
