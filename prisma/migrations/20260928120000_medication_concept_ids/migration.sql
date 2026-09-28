-- 9.13.3: several standard concepts for one home medication.
--
-- A combination product (valsartan with hydrochlorothiazide) was exported as
-- the one ingredient its ATC code's "Maps to" names, or as concept 0 when that
-- named several. It now takes the combination's own RxNorm concept when one
-- matches the product; otherwise the ids of every ingredient sit here and the
-- export writes one drug_exposure row per ingredient, as conditions already do.
ALTER TABLE "Medication" ADD COLUMN "standardConceptIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[];
