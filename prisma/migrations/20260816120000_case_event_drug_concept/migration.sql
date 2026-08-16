-- Store the drug concept resolved when an intraoperative event is written.
--
-- Preop medications have always carried standardConceptId/mappingStatus, so the
-- OMOP export could map them. Intraoperative drug events carried only the ATC,
-- and the export hardcoded drug_concept_id to 0 — meaning the drugs actually
-- administered were the unmapped half of the dataset, while the same drug
-- listed preoperatively mapped correctly.
--
-- Resolving at write time (rather than looking up on every export) keeps the
-- export a pure function of the stored record: exporting the same case twice
-- produces the same file.
--
-- Both columns are additive. Existing rows default to SOURCE_ONLY with no
-- concept, which is exactly how they behave today, so this needs no backfill
-- and cannot alter data already recorded. Historic rows can be resolved later
-- by a deliberate re-resolve, which is a visible, dated action rather than a
-- silent drift.
ALTER TABLE "CaseEvent" ADD COLUMN IF NOT EXISTS "standardConceptId" INTEGER;
ALTER TABLE "CaseEvent" ADD COLUMN IF NOT EXISTS "mappingStatus" "ConceptMappingStatus" NOT NULL DEFAULT 'SOURCE_ONLY';
