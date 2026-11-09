-- Intraoperative automation (10.1.0): the settings a hospital switches on in
-- Status (everything off until then), and the end of a complication episode.
-- Existing rows are untouched: no complication gains a time it did not have.

-- CreateTable
CREATE TABLE "IntraopAutomationPolicy" (
    "id" TEXT NOT NULL DEFAULT 'local',
    "config" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntraopAutomationPolicy_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "CaseComplication" ADD COLUMN "endTimestamp" TIMESTAMP(3);
