-- One preoperative profile for adults and one for children (9.14.5).
--
-- The existing profile becomes the adult one. The paediatric profile is
-- created by the API on first use as a copy of it, so every choice an
-- operator already made carries over to both populations unchanged.
ALTER TABLE "PreopAssessmentProfile"
    ADD COLUMN "population" "ClinicalMode" NOT NULL DEFAULT 'ADULT';

-- One published profile per population, where there was one in all.
DROP INDEX "PreopAssessmentProfile_one_published";
CREATE UNIQUE INDEX "PreopAssessmentProfile_one_published"
    ON "PreopAssessmentProfile"("population") WHERE "status" = 'PUBLISHED';

DROP INDEX "PreopAssessmentProfile_status_version_idx";
CREATE INDEX "PreopAssessmentProfile_population_status_version_idx"
    ON "PreopAssessmentProfile"("population", "status", "version");
