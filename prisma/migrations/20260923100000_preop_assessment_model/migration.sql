-- 1.4.7 definition-driven preoperative catalog, profile, answer, suggestion,
-- case-pin, and audit storage. Legacy wide preoperative columns remain for
-- compatibility; these relational tables are authoritative for catalog items.

CREATE TYPE "PreopProfileStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');
CREATE TYPE "PreopAnswerType" AS ENUM ('BOOLEAN', 'CHOICE', 'NUMBER', 'TEXT', 'DATE');
CREATE TYPE "PreopAnswerState" AS ENUM ('YES', 'NO', 'UNKNOWN', 'NOT_APPLICABLE', 'NOT_ASKED');
CREATE TYPE "PreopSuggestionStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

CREATE TABLE "PreopQuestionDefinition" (
    "id" TEXT NOT NULL,
    "stableKey" TEXT NOT NULL,
    "catalogVersion" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "applicability" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "answerType" "PreopAnswerType" NOT NULL,
    "labelEn" TEXT NOT NULL,
    "labelBg" TEXT NOT NULL,
    "helpEn" TEXT,
    "helpBg" TEXT,
    "requiredDefault" BOOLEAN NOT NULL DEFAULT false,
    "allowUnknown" BOOLEAN NOT NULL DEFAULT false,
    "allowNotApplicable" BOOLEAN NOT NULL DEFAULT false,
    "conditionalRuleKey" TEXT,
    "omopDomain" TEXT,
    "omopConceptId" INTEGER,
    "omopVocabulary" TEXT,
    "omopSourceCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PreopQuestionDefinition_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PreopAnswerOption" (
    "id" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "labelEn" TEXT NOT NULL,
    "labelBg" TEXT NOT NULL,
    "omopConceptId" INTEGER,
    "omopVocabulary" TEXT,
    "omopSourceCode" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "PreopAnswerOption_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PreopAssessmentProfile" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "catalogVersion" TEXT NOT NULL,
    "status" "PreopProfileStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "publishedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PreopAssessmentProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PreopCaseProfilePin" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "profileVersion" INTEGER NOT NULL,
    "pinnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pinnedById" TEXT,
    "adoptedAt" TIMESTAMP(3),
    "adoptedById" TEXT,
    CONSTRAINT "PreopCaseProfilePin_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PreopProfileQuestion" (
    "profileId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "PreopProfileQuestion_pkey" PRIMARY KEY ("profileId", "questionId")
);

CREATE TABLE "PreopAssessmentAnswer" (
    "id" TEXT NOT NULL,
    "preopId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "profileVersion" INTEGER NOT NULL,
    "state" "PreopAnswerState" NOT NULL,
    "optionKey" TEXT,
    "valueText" TEXT,
    "valueNumber" DOUBLE PRECISION,
    "valueDate" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'clinician',
    "provenance" JSONB,
    "authorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PreopAssessmentAnswer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PreopAssessmentSuggestion" (
    "id" TEXT NOT NULL,
    "preopId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "profileVersion" INTEGER NOT NULL,
    "proposedState" "PreopAnswerState",
    "proposedOptionKey" TEXT,
    "proposedValueText" TEXT,
    "proposedValueNumber" DOUBLE PRECISION,
    "linkedDiagnosisId" TEXT,
    "evidence" JSONB NOT NULL,
    "ruleId" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "status" "PreopSuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PreopAssessmentSuggestion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PreopAssessmentAuditEvent" (
    "id" TEXT NOT NULL,
    "profileId" TEXT,
    "caseId" TEXT,
    "action" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PreopAssessmentAuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PreopQuestionDefinition_stableKey_key"
    ON "PreopQuestionDefinition"("stableKey");
CREATE INDEX "PreopQuestionDefinition_catalogVersion_section_idx"
    ON "PreopQuestionDefinition"("catalogVersion", "section");
CREATE UNIQUE INDEX "PreopAnswerOption_questionId_key_key"
    ON "PreopAnswerOption"("questionId", "key");
CREATE INDEX "PreopAnswerOption_questionId_sortOrder_idx"
    ON "PreopAnswerOption"("questionId", "sortOrder");
CREATE UNIQUE INDEX "PreopAssessmentProfile_version_key"
    ON "PreopAssessmentProfile"("version");
CREATE INDEX "PreopAssessmentProfile_status_version_idx"
    ON "PreopAssessmentProfile"("status", "version");
CREATE UNIQUE INDEX "PreopAssessmentProfile_one_published"
    ON "PreopAssessmentProfile"((1)) WHERE "status" = 'PUBLISHED';
CREATE UNIQUE INDEX "PreopCaseProfilePin_caseId_key"
    ON "PreopCaseProfilePin"("caseId");
CREATE INDEX "PreopCaseProfilePin_profileId_profileVersion_idx"
    ON "PreopCaseProfilePin"("profileId", "profileVersion");
CREATE INDEX "PreopProfileQuestion_profileId_enabled_sortOrder_idx"
    ON "PreopProfileQuestion"("profileId", "enabled", "sortOrder");
CREATE UNIQUE INDEX "PreopAssessmentAnswer_preopId_questionId_profileVersion_key"
    ON "PreopAssessmentAnswer"("preopId", "questionId", "profileVersion");
CREATE INDEX "PreopAssessmentAnswer_preopId_profileVersion_idx"
    ON "PreopAssessmentAnswer"("preopId", "profileVersion");
CREATE INDEX "PreopAssessmentAnswer_questionId_state_idx"
    ON "PreopAssessmentAnswer"("questionId", "state");
CREATE INDEX "PreopAssessmentSuggestion_preopId_status_idx"
    ON "PreopAssessmentSuggestion"("preopId", "status");
CREATE INDEX "PreopAssessmentSuggestion_questionId_status_idx"
    ON "PreopAssessmentSuggestion"("questionId", "status");
CREATE INDEX "PreopAssessmentSuggestion_linkedDiagnosisId_idx"
    ON "PreopAssessmentSuggestion"("linkedDiagnosisId");
CREATE UNIQUE INDEX "PreopAssessmentSuggestion_preopId_questionId_ruleId_ruleVersion_key"
    ON "PreopAssessmentSuggestion"("preopId", "questionId", "ruleId", "ruleVersion");
CREATE INDEX "PreopAssessmentAuditEvent_profileId_createdAt_idx"
    ON "PreopAssessmentAuditEvent"("profileId", "createdAt");
CREATE INDEX "PreopAssessmentAuditEvent_caseId_createdAt_idx"
    ON "PreopAssessmentAuditEvent"("caseId", "createdAt");
CREATE INDEX "PreopAssessmentAuditEvent_actorId_createdAt_idx"
    ON "PreopAssessmentAuditEvent"("actorId", "createdAt");

ALTER TABLE "PreopAnswerOption"
  ADD CONSTRAINT "PreopAnswerOption_questionId_fkey"
  FOREIGN KEY ("questionId") REFERENCES "PreopQuestionDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PreopCaseProfilePin"
  ADD CONSTRAINT "PreopCaseProfilePin_caseId_fkey"
  FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PreopCaseProfilePin"
  ADD CONSTRAINT "PreopCaseProfilePin_profileId_fkey"
  FOREIGN KEY ("profileId") REFERENCES "PreopAssessmentProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PreopProfileQuestion"
  ADD CONSTRAINT "PreopProfileQuestion_profileId_fkey"
  FOREIGN KEY ("profileId") REFERENCES "PreopAssessmentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PreopProfileQuestion"
  ADD CONSTRAINT "PreopProfileQuestion_questionId_fkey"
  FOREIGN KEY ("questionId") REFERENCES "PreopQuestionDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PreopAssessmentAnswer"
  ADD CONSTRAINT "PreopAssessmentAnswer_preopId_fkey"
  FOREIGN KEY ("preopId") REFERENCES "PreoperativeAssessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PreopAssessmentAnswer"
  ADD CONSTRAINT "PreopAssessmentAnswer_questionId_fkey"
  FOREIGN KEY ("questionId") REFERENCES "PreopQuestionDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PreopAssessmentAnswer"
  ADD CONSTRAINT "PreopAssessmentAnswer_option_fkey"
  FOREIGN KEY ("questionId", "optionKey") REFERENCES "PreopAnswerOption"("questionId", "key") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PreopAssessmentSuggestion"
  ADD CONSTRAINT "PreopAssessmentSuggestion_preopId_fkey"
  FOREIGN KEY ("preopId") REFERENCES "PreoperativeAssessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PreopAssessmentSuggestion"
  ADD CONSTRAINT "PreopAssessmentSuggestion_questionId_fkey"
  FOREIGN KEY ("questionId") REFERENCES "PreopQuestionDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PreopAssessmentSuggestion"
  ADD CONSTRAINT "PreopAssessmentSuggestion_linkedDiagnosisId_fkey"
  FOREIGN KEY ("linkedDiagnosisId") REFERENCES "PreopDiagnosis"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PreopAssessmentAuditEvent"
  ADD CONSTRAINT "PreopAssessmentAuditEvent_profileId_fkey"
  FOREIGN KEY ("profileId") REFERENCES "PreopAssessmentProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
