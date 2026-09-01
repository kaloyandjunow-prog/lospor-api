-- Per-item clinical provenance for the four tag-mirror tables.
--
-- Each of these tables already has a `source` column, but it is hard-coded to
-- the literal "relational-sync" (SYNC_SOURCE in relational-sync.ts) for every
-- row the mirror writes -- it records that the row is a rebuildable
-- projection of the JSON columns, not who or what recorded the underlying
-- diagnosis/procedure/comorbidity/medication. Reusing it for clinical
-- provenance ("manual" | "ai-scan" | "import") would have collapsed two
-- different facts into one column and made the sync-audit meaning
-- unrecoverable for existing rows.
--
-- Nullable with no default: existing rows never carried this information, and
-- NULL ("unknown") is the honest statement for them. Only newly-synced rows
-- populate it, sourced from the same `source` key already carried on the
-- canonical JSON item (labelledItem is .passthrough(), so diagnoses/
-- procedures/comorbidities already round-trip it; medications carry it
-- through taggedListToStorage as of this change).
ALTER TABLE "PreopDiagnosis" ADD COLUMN "clinicalSource" TEXT;
ALTER TABLE "PreopProcedure" ADD COLUMN "clinicalSource" TEXT;
ALTER TABLE "Comorbidity" ADD COLUMN "clinicalSource" TEXT;
ALTER TABLE "Medication" ADD COLUMN "clinicalSource" TEXT;
