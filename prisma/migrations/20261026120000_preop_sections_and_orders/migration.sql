-- Switchable preop sections, preoperative ward orders and medication
-- instructions (9.16.0).
--
-- A hospital's choices hang off each population's preop profile, beside its
-- questions; the API provisions the rows from Core on first use, as it does
-- the questions. A case's orders and instructions hang off its preoperative
-- assessment, keep their own copy of what was ordered, and are cancelled
-- rather than deleted. Nothing is backfilled: no appliance holds live cases.


-- CreateEnum
CREATE TYPE "PreopOrderStatus" AS ENUM ('ACTIVE', 'CANCELLED');

-- CreateTable
CREATE TABLE "PreopProfileSection" (
    "profileId" TEXT NOT NULL,
    "sectionKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "PreopProfileSection_pkey" PRIMARY KEY ("profileId","sectionKey")
);

-- CreateTable
CREATE TABLE "PreopProfileOrderOption" (
    "profileId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "list" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "labelEn" TEXT NOT NULL,
    "labelBg" TEXT NOT NULL,
    "conceptId" INTEGER NOT NULL DEFAULT 0,
    "bundled" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "hoursMode" TEXT NOT NULL DEFAULT 'NONE',
    "labTest" TEXT,

    CONSTRAINT "PreopProfileOrderOption_pkey" PRIMARY KEY ("profileId","key")
);

-- CreateTable
CREATE TABLE "PreopProfileConsultSpecialty" (
    "profileId" TEXT NOT NULL,
    "specialtyKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PreopProfileConsultSpecialty_pkey" PRIMARY KEY ("profileId","specialtyKey")
);

-- CreateTable
CREATE TABLE "PreopWardOrder" (
    "id" TEXT NOT NULL,
    "preopId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "optionKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "labelEn" TEXT NOT NULL,
    "labelBg" TEXT NOT NULL,
    "conceptId" INTEGER NOT NULL DEFAULT 0,
    "specialtyKey" TEXT,
    "specialtyLabelEn" TEXT,
    "specialtyLabelBg" TEXT,
    "labTest" TEXT,
    "labLoinc" TEXT,
    "labConceptId" INTEGER,
    "status" "PreopOrderStatus" NOT NULL DEFAULT 'ACTIVE',
    "authorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "PreopWardOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PreopMedicationInstruction" (
    "id" TEXT NOT NULL,
    "preopId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "optionKey" TEXT NOT NULL,
    "labelEn" TEXT NOT NULL,
    "labelBg" TEXT NOT NULL,
    "conceptId" INTEGER NOT NULL DEFAULT 0,
    "medicationLabel" TEXT NOT NULL,
    "medicationInn" TEXT,
    "medicationAtc" TEXT,
    "hoursBefore" INTEGER,
    "status" "PreopOrderStatus" NOT NULL DEFAULT 'ACTIVE',
    "authorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "PreopMedicationInstruction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PreopProfileOrderOption_profileId_list_sortOrder_idx" ON "PreopProfileOrderOption"("profileId", "list", "sortOrder");

-- CreateIndex
CREATE INDEX "PreopWardOrder_preopId_status_idx" ON "PreopWardOrder"("preopId", "status");

-- CreateIndex
CREATE INDEX "PreopWardOrder_caseId_idx" ON "PreopWardOrder"("caseId");

-- CreateIndex
CREATE INDEX "PreopWardOrder_optionKey_idx" ON "PreopWardOrder"("optionKey");

-- CreateTable
CREATE TABLE "PreopPremedicationOrder" (
    "id" TEXT NOT NULL,
    "preopId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "entry" TEXT NOT NULL,
    "drug" TEXT,
    "atcCode" TEXT,
    "dose" DOUBLE PRECISION,
    "unit" TEXT,
    "route" TEXT,
    "conceptId" INTEGER,
    "ordinal" INTEGER NOT NULL DEFAULT 0,
    "status" "PreopOrderStatus" NOT NULL DEFAULT 'ACTIVE',
    "authorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "PreopPremedicationOrder_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PreopPremedicationOrder_preopId_status_idx" ON "PreopPremedicationOrder"("preopId", "status");

-- CreateIndex
CREATE INDEX "PreopPremedicationOrder_caseId_idx" ON "PreopPremedicationOrder"("caseId");

-- AddForeignKey
ALTER TABLE "PreopPremedicationOrder" ADD CONSTRAINT "PreopPremedicationOrder_preopId_fkey" FOREIGN KEY ("preopId") REFERENCES "PreoperativeAssessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "PreopMedicationInstruction_preopId_status_idx" ON "PreopMedicationInstruction"("preopId", "status");

-- CreateIndex
CREATE INDEX "PreopMedicationInstruction_caseId_idx" ON "PreopMedicationInstruction"("caseId");

-- CreateIndex
CREATE UNIQUE INDEX "PreopMedicationInstruction_preopId_clientId_key" ON "PreopMedicationInstruction"("preopId", "clientId");

-- AddForeignKey
ALTER TABLE "PreopProfileSection" ADD CONSTRAINT "PreopProfileSection_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "PreopAssessmentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PreopProfileOrderOption" ADD CONSTRAINT "PreopProfileOrderOption_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "PreopAssessmentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PreopProfileConsultSpecialty" ADD CONSTRAINT "PreopProfileConsultSpecialty_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "PreopAssessmentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PreopWardOrder" ADD CONSTRAINT "PreopWardOrder_preopId_fkey" FOREIGN KEY ("preopId") REFERENCES "PreoperativeAssessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PreopMedicationInstruction" ADD CONSTRAINT "PreopMedicationInstruction_preopId_fkey" FOREIGN KEY ("preopId") REFERENCES "PreoperativeAssessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Like the answers: no write to a finalised case, and every write bumps the
-- case's clinical revision so sync and export see it.
CREATE TRIGGER "PreopWardOrder_guard_case_write"
BEFORE INSERT OR UPDATE OR DELETE ON "PreopWardOrder"
FOR EACH ROW EXECUTE FUNCTION lospor_guard_preop_child_write();
CREATE TRIGGER "PreopWardOrder_touch_case_revision"
AFTER INSERT OR UPDATE OR DELETE ON "PreopWardOrder"
FOR EACH ROW EXECUTE FUNCTION lospor_touch_case_from_preop_child();

CREATE TRIGGER "PreopMedicationInstruction_guard_case_write"
BEFORE INSERT OR UPDATE OR DELETE ON "PreopMedicationInstruction"
FOR EACH ROW EXECUTE FUNCTION lospor_guard_preop_child_write();
CREATE TRIGGER "PreopMedicationInstruction_touch_case_revision"
AFTER INSERT OR UPDATE OR DELETE ON "PreopMedicationInstruction"
FOR EACH ROW EXECUTE FUNCTION lospor_touch_case_from_preop_child();

CREATE TRIGGER "PreopPremedicationOrder_guard_case_write"
BEFORE INSERT OR UPDATE OR DELETE ON "PreopPremedicationOrder"
FOR EACH ROW EXECUTE FUNCTION lospor_guard_preop_child_write();
CREATE TRIGGER "PreopPremedicationOrder_touch_case_revision"
AFTER INSERT OR UPDATE OR DELETE ON "PreopPremedicationOrder"
FOR EACH ROW EXECUTE FUNCTION lospor_touch_case_from_preop_child();
