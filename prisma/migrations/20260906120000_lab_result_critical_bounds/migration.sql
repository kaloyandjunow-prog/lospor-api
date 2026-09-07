-- Explicit critical thresholds on a laboratory result.
--
-- These are only ever the laboratory's own. Nothing in the bundled catalogue
-- states a critical value, and deriving one arithmetically from a reference
-- range is what made a sodium of 130 read as critical -- the reason the rule
-- now refuses to guess and acts only on a stated threshold.
--
-- The FHIR reader has been extracting them from referenceRange entries typed as
-- critical since it was written, and until today normalisation dropped them on
-- the floor. With that fixed they reach the case; without these columns they
-- would stop at the JSON blob, so the relational mirror and the OMOP export
-- could never call anything critical however extreme the value.
--
-- Nullable, and expected to be null for most results: a laboratory states a
-- critical threshold for the assays where one exists, not for every row.
ALTER TABLE "LabResult"
  ADD COLUMN "criticalLow"  DOUBLE PRECISION,
  ADD COLUMN "criticalHigh" DOUBLE PRECISION;
