-- Concept mapping provenance: two statuses the export could not express.
--
-- MAPPED covered both an automatic resolution and one a human reviewed and
-- signed off, so a study could not tell a string-similarity match from a
-- curated mapping. UNMAPPED covered both "nobody has looked yet" and "a
-- candidate was considered and rejected", so rejected candidates were
-- indistinguishable from unfinished work and got proposed again on every
-- review pass.
--
-- Existing rows keep their current status. MAPPED is not rewritten to
-- MANUALLY_CURATED for rows where reviewed = true, because `reviewed` was set
-- by more than one path and promoting them wholesale would assert a level of
-- evidence nobody checked. Curation is recorded going forward.

ALTER TYPE "ConceptMappingStatus" ADD VALUE IF NOT EXISTS 'MANUALLY_CURATED';
ALTER TYPE "ConceptMappingStatus" ADD VALUE IF NOT EXISTS 'REJECTED';
