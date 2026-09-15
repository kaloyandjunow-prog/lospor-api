-- Several standard concepts for one source code.
--
-- OMOP decomposes some ICD-10 combination codes into more than one standard
-- concept: E11.2 is both type 2 diabetes and a kidney disorder due to it. One
-- concept column could hold only one of them, so such codes exported none. The
-- ids now sit in an array, and the export writes one condition row per id.
ALTER TABLE "ConceptMap" ADD COLUMN "standardConceptIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[];
ALTER TABLE "PreopDiagnosis" ADD COLUMN "standardConceptIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[];
ALTER TABLE "Comorbidity" ADD COLUMN "standardConceptIds" INTEGER[] DEFAULT ARRAY[]::INTEGER[];
