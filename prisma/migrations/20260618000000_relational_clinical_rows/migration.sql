-- v1.2: normalise JSON clinical arrays into queryable rows (additive; JSON kept).

-- Typed vital columns on CaseEvent (populated for type = 'vital').
ALTER TABLE "CaseEvent" ADD COLUMN IF NOT EXISTS "systolic"  INTEGER;
ALTER TABLE "CaseEvent" ADD COLUMN IF NOT EXISTS "diastolic" INTEGER;
ALTER TABLE "CaseEvent" ADD COLUMN IF NOT EXISTS "heartRate" INTEGER;
ALTER TABLE "CaseEvent" ADD COLUMN IF NOT EXISTS "spO2"      DOUBLE PRECISION;
ALTER TABLE "CaseEvent" ADD COLUMN IF NOT EXISTS "etco2"     DOUBLE PRECISION;
ALTER TABLE "CaseEvent" ADD COLUMN IF NOT EXISTS "temp"      DOUBLE PRECISION;

CREATE TABLE "PreopDiagnosis" (
  "id" TEXT NOT NULL, "preopId" TEXT NOT NULL, "caseId" TEXT NOT NULL,
  "code" TEXT, "label" TEXT NOT NULL, "system" TEXT,
  "ordinal" INTEGER NOT NULL DEFAULT 0, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PreopDiagnosis_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PreopDiagnosis_caseId_idx"  ON "PreopDiagnosis"("caseId");
CREATE INDEX "PreopDiagnosis_preopId_idx" ON "PreopDiagnosis"("preopId");
CREATE INDEX "PreopDiagnosis_code_idx"    ON "PreopDiagnosis"("code");
ALTER TABLE "PreopDiagnosis" ADD CONSTRAINT "PreopDiagnosis_preopId_fkey"
  FOREIGN KEY ("preopId") REFERENCES "PreoperativeAssessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PreopProcedure" (
  "id" TEXT NOT NULL, "preopId" TEXT NOT NULL, "caseId" TEXT NOT NULL,
  "code" TEXT, "group" TEXT, "domain" TEXT, "description" TEXT,
  "ordinal" INTEGER NOT NULL DEFAULT 0, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PreopProcedure_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PreopProcedure_caseId_idx"  ON "PreopProcedure"("caseId");
CREATE INDEX "PreopProcedure_preopId_idx" ON "PreopProcedure"("preopId");
CREATE INDEX "PreopProcedure_code_idx"    ON "PreopProcedure"("code");
ALTER TABLE "PreopProcedure" ADD CONSTRAINT "PreopProcedure_preopId_fkey"
  FOREIGN KEY ("preopId") REFERENCES "PreoperativeAssessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Comorbidity" (
  "id" TEXT NOT NULL, "preopId" TEXT NOT NULL, "caseId" TEXT NOT NULL,
  "label" TEXT NOT NULL, "code" TEXT, "system" TEXT,
  "ordinal" INTEGER NOT NULL DEFAULT 0, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Comorbidity_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Comorbidity_caseId_idx"  ON "Comorbidity"("caseId");
CREATE INDEX "Comorbidity_preopId_idx" ON "Comorbidity"("preopId");
CREATE INDEX "Comorbidity_code_idx"    ON "Comorbidity"("code");
ALTER TABLE "Comorbidity" ADD CONSTRAINT "Comorbidity_preopId_fkey"
  FOREIGN KEY ("preopId") REFERENCES "PreoperativeAssessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "LabResult" (
  "id" TEXT NOT NULL, "preopId" TEXT NOT NULL, "caseId" TEXT NOT NULL,
  "test" TEXT NOT NULL, "value" TEXT, "unit" TEXT,
  "ordinal" INTEGER NOT NULL DEFAULT 0, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LabResult_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "LabResult_caseId_idx"  ON "LabResult"("caseId");
CREATE INDEX "LabResult_preopId_idx" ON "LabResult"("preopId");
CREATE INDEX "LabResult_test_idx"    ON "LabResult"("test");
ALTER TABLE "LabResult" ADD CONSTRAINT "LabResult_preopId_fkey"
  FOREIGN KEY ("preopId") REFERENCES "PreoperativeAssessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "VascularAccess" (
  "id" TEXT NOT NULL, "intraopId" TEXT NOT NULL, "caseId" TEXT NOT NULL,
  "site" TEXT, "siteLabel" TEXT, "size" TEXT, "sizeUnit" TEXT,
  "ordinal" INTEGER NOT NULL DEFAULT 0, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VascularAccess_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "VascularAccess_caseId_idx"    ON "VascularAccess"("caseId");
CREATE INDEX "VascularAccess_intraopId_idx" ON "VascularAccess"("intraopId");
ALTER TABLE "VascularAccess" ADD CONSTRAINT "VascularAccess_intraopId_fkey"
  FOREIGN KEY ("intraopId") REFERENCES "IntraoperativeRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CaseSelection" (
  "id" TEXT NOT NULL, "caseId" TEXT NOT NULL,
  "section" TEXT NOT NULL, "category" TEXT NOT NULL, "value" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL DEFAULT 0, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CaseSelection_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CaseSelection_caseId_idx"          ON "CaseSelection"("caseId");
CREATE INDEX "CaseSelection_category_value_idx"  ON "CaseSelection"("category", "value");
ALTER TABLE "CaseSelection" ADD CONSTRAINT "CaseSelection_caseId_fkey"
  FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
