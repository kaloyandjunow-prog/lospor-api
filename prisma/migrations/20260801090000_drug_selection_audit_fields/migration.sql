-- Preserve the exact route-profile inputs used for an administered drug.
-- Existing `concentration` and `metadataJson` values remain untouched so old
-- clients and historical event projections continue to round-trip.
ALTER TABLE "CaseEvent"
  ADD COLUMN "concentrationValue" DOUBLE PRECISION,
  ADD COLUMN "concentrationUnit" TEXT,
  ADD COLUMN "formulation" TEXT,
  ADD COLUMN "calculationBasis" TEXT,
  ADD COLUMN "calculationWeightKg" DOUBLE PRECISION,
  ADD COLUMN "calculationMethod" TEXT,
  ADD COLUMN "clinicalRuleKey" TEXT,
  ADD COLUMN "clinicalRuleVersion" TEXT,
  ADD COLUMN "clinicalRuleSourceIds" JSONB,
  ADD COLUMN "clinicalPresetId" TEXT,
  ADD COLUMN "clinicalPresetVersion" INTEGER,
  ADD COLUMN "clinicalPresetScope" TEXT;

CREATE INDEX "CaseEvent_clinicalRuleKey_clinicalRuleVersion_idx"
  ON "CaseEvent"("clinicalRuleKey", "clinicalRuleVersion");

CREATE INDEX "CaseEvent_clinicalPresetId_clinicalPresetVersion_idx"
  ON "CaseEvent"("clinicalPresetId", "clinicalPresetVersion");
