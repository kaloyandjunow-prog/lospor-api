-- Persist mobile preop free-text fields that were previously accepted but dropped.
ALTER TABLE "PreoperativeAssessment"
    ADD COLUMN "physicalExamReport" TEXT,
    ADD COLUMN "notes" TEXT;
