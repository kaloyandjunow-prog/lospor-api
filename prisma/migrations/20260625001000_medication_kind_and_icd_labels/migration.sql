CREATE TYPE "MedicationKind" AS ENUM ('CURRENT', 'ALLERGY');

ALTER TABLE "Medication"
  ADD COLUMN "kind" "MedicationKind" NOT NULL DEFAULT 'CURRENT';

ALTER TABLE "PreopDiagnosis"
  ADD COLUMN "labelEn" TEXT,
  ADD COLUMN "labelBg" TEXT;

ALTER TABLE "Comorbidity"
  ADD COLUMN "labelEn" TEXT,
  ADD COLUMN "labelBg" TEXT;

CREATE INDEX "Medication_kind_idx" ON "Medication"("kind");
CREATE INDEX "Medication_caseId_kind_idx" ON "Medication"("caseId", "kind");
CREATE INDEX "Medication_preopId_kind_idx" ON "Medication"("preopId", "kind");
