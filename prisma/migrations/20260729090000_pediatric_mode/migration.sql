CREATE TYPE "ClinicalMode" AS ENUM ('ADULT', 'PEDIATRIC');
CREATE TYPE "PediatricAgeUnit" AS ENUM ('DAYS', 'MONTHS', 'YEARS');
CREATE TYPE "PediatricPainScale" AS ENUM ('FLACC', 'FPS_R', 'NRS');
CREATE TYPE "ClinicalRuleReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'DEPRECATED');

ALTER TABLE "Case"
  ADD COLUMN "clinicalMode" "ClinicalMode" NOT NULL DEFAULT 'ADULT',
  ADD COLUMN "clinicalRulesVersion" TEXT;

ALTER TABLE "PreoperativeAssessment"
  ADD COLUMN "ageValue" INTEGER,
  ADD COLUMN "ageUnit" "PediatricAgeUnit",
  ADD COLUMN "gestationalAgeWeeks" DOUBLE PRECISION,
  ADD COLUMN "postmenstrualAgeWeeks" DOUBLE PRECISION,
  ADD COLUMN "bodySurfaceAreaM2" DOUBLE PRECISION,
  ADD COLUMN "povocScore" INTEGER,
  ADD COLUMN "povocRiskPercent" DOUBLE PRECISION,
  ADD COLUMN "povocSurgeryAtLeast30Minutes" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "povocAgeAtLeast3Years" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "povocStrabismusSurgery" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "povocHistory" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "coldsApplicable" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "coldsScore" INTEGER,
  ADD COLUMN "coldsCurrentSymptoms" TEXT,
  ADD COLUMN "coldsOnset" TEXT,
  ADD COLUMN "coldsLungDisease" TEXT,
  ADD COLUMN "coldsAirwayDevice" TEXT,
  ADD COLUMN "coldsSurgery" TEXT,
  ADD COLUMN "pediatricFasting" JSONB NOT NULL DEFAULT '[]';

ALTER TABLE "PostoperativeRecord"
  ADD COLUMN "pediatricPainScale" "PediatricPainScale",
  ADD COLUMN "pediatricPainScore" INTEGER,
  ADD COLUMN "paedScore" INTEGER;

CREATE TABLE "CaseClinicalCalculation" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "inputs" JSONB NOT NULL,
  "outputs" JSONB NOT NULL,
  "ruleVersion" TEXT NOT NULL,
  "sourceRefs" JSONB NOT NULL DEFAULT '[]',
  "acceptedBy" TEXT,
  "acceptedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CaseClinicalCalculation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CaseClinicalCalculation_caseId_fkey"
    FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "CaseClinicalCalculation_caseId_kind_idx"
  ON "CaseClinicalCalculation"("caseId", "kind");
CREATE INDEX "CaseClinicalCalculation_ruleVersion_idx"
  ON "CaseClinicalCalculation"("ruleVersion");

CREATE TABLE "ClinicalRuleReview" (
  "id" TEXT NOT NULL,
  "ruleKey" TEXT NOT NULL,
  "ruleVersion" TEXT NOT NULL,
  "status" "ClinicalRuleReviewStatus" NOT NULL DEFAULT 'PENDING',
  "reviewerId" TEXT,
  "reviewerNotes" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ClinicalRuleReview_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ClinicalRuleReview_reviewerId_fkey"
    FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ClinicalRuleReview_ruleKey_ruleVersion_key"
  ON "ClinicalRuleReview"("ruleKey", "ruleVersion");
CREATE INDEX "ClinicalRuleReview_status_idx" ON "ClinicalRuleReview"("status");

CREATE TABLE "InstitutionClinicalRuleOverride" (
  "id" TEXT NOT NULL,
  "institutionId" TEXT NOT NULL,
  "ruleKey" TEXT NOT NULL,
  "baseRuleVersion" TEXT NOT NULL,
  "overrideVersion" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "sourceRefs" JSONB NOT NULL DEFAULT '[]',
  "rationale" TEXT NOT NULL,
  "status" "ClinicalRuleReviewStatus" NOT NULL DEFAULT 'PENDING',
  "designatedReviewerId" TEXT,
  "designatedReviewedAt" TIMESTAMP(3),
  "hodApproverId" TEXT,
  "hodApprovedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InstitutionClinicalRuleOverride_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InstitutionClinicalRuleOverride_institutionId_fkey"
    FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "InstitutionClinicalRuleOverride_designatedReviewerId_fkey"
    FOREIGN KEY ("designatedReviewerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "InstitutionClinicalRuleOverride_hodApproverId_fkey"
    FOREIGN KEY ("hodApproverId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "InstitutionClinicalRuleOverride_institutionId_ruleKey_overrideVersion_key"
  ON "InstitutionClinicalRuleOverride"("institutionId", "ruleKey", "overrideVersion");
CREATE INDEX "InstitutionClinicalRuleOverride_institutionId_status_idx"
  ON "InstitutionClinicalRuleOverride"("institutionId", "status");

DROP TRIGGER "Case_touch_clinical_revision" ON "Case";
CREATE TRIGGER "Case_touch_clinical_revision"
BEFORE UPDATE OF "caseCode", "notes", "userId", "institutionId", "status", "finalizedAt", "clinicalMode", "clinicalRulesVersion"
ON "Case"
FOR EACH ROW
EXECUTE FUNCTION lospor_touch_case_parent_revision();

CREATE TRIGGER "CaseClinicalCalculation_guard_case_write"
BEFORE INSERT OR UPDATE OR DELETE ON "CaseClinicalCalculation"
FOR EACH ROW EXECUTE FUNCTION lospor_guard_clinical_child_write();
CREATE TRIGGER "CaseClinicalCalculation_touch_case_revision"
AFTER INSERT OR UPDATE OR DELETE ON "CaseClinicalCalculation"
FOR EACH ROW EXECUTE FUNCTION lospor_touch_case_from_child();
