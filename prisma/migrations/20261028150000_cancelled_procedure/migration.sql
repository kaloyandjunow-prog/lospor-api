-- A cancelled procedure, a planned procedure not yet known, and the procedure
-- done (10.0.0). Nothing is backfilled: no case is cancelled, every planned
-- procedure stays as it was, and the procedure done starts empty.

-- AlterEnum
ALTER TYPE "CaseStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "Case" ADD COLUMN "cancelledAt" TIMESTAMP(3),
ADD COLUMN "cancelledById" TEXT,
ADD COLUMN "cancellationReason" TEXT,
ADD COLUMN "cancellationNote" TEXT,
ADD COLUMN "statusBeforeCancel" "CaseStatus";

-- AlterTable
ALTER TABLE "PreoperativeAssessment" ADD COLUMN "procedureUndetermined" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "PostoperativeRecord" ADD COLUMN "performedProceduresJson" JSONB;

-- The procedure done, coded (relational sync fills it from performedProceduresJson).
-- CreateTable
CREATE TABLE "PerformedProcedure" (
    "id" TEXT NOT NULL,
    "postopId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "code" TEXT,
    "group" TEXT,
    "domain" TEXT,
    "description" TEXT,
    "sourceVocabulary" TEXT,
    "sourceCode" TEXT,
    "standardConceptId" INTEGER,
    "mappingStatus" "ConceptMappingStatus" NOT NULL DEFAULT 'SOURCE_ONLY',
    "source" TEXT NOT NULL DEFAULT 'sync',
    "clinicalSource" TEXT,
    "sourceVersion" TEXT,
    "ordinal" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PerformedProcedure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PerformedProcedure_caseId_idx" ON "PerformedProcedure"("caseId");

-- CreateIndex
CREATE INDEX "PerformedProcedure_postopId_idx" ON "PerformedProcedure"("postopId");

-- CreateIndex
CREATE INDEX "PerformedProcedure_standardConceptId_idx" ON "PerformedProcedure"("standardConceptId");

-- AddForeignKey
ALTER TABLE "PerformedProcedure" ADD CONSTRAINT "PerformedProcedure_postopId_fkey" FOREIGN KEY ("postopId") REFERENCES "PostoperativeRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
