-- Enable pg_trgm for fast ILIKE '%term%' substring searches.
-- Without this, ICD-10 synonym searches (107k rows) do full table scans.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ICD-10 label and synonym columns — the main diagnosis/comorbidity search path
CREATE INDEX IF NOT EXISTS "Icd10Code_labelEn_trgm_idx" ON "Icd10Code" USING GIN ("labelEn" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Icd10Code_labelBg_trgm_idx" ON "Icd10Code" USING GIN ("labelBg" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Icd10Synonym_synonym_trgm_idx" ON "Icd10Synonym" USING GIN ("synonym" gin_trgm_ops);

-- Drug search columns
CREATE INDEX IF NOT EXISTS "Drug_name_trgm_idx" ON "Drug" USING GIN ("name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "Drug_inn_trgm_idx"  ON "Drug" USING GIN ("inn"  gin_trgm_ops);
