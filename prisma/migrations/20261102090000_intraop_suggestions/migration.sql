-- 10.2.0 SPS.

-- Death logged in theatre sets the postop destination to Deceased.
ALTER TYPE "Disposition" ADD VALUE 'DECEASED';

-- Each airway device its own entry. Empty on every case saved before; those
-- keep reading from airwayDevices and the size columns, never rewritten.
ALTER TABLE "IntraoperativeRecord" ADD COLUMN "airwayDeviceEntries" JSONB NOT NULL DEFAULT '[]';

-- The suggestion a timed complication was logged from, exported as a flag.
ALTER TABLE "CaseComplication" ADD COLUMN "suggestion" TEXT;

-- A vascular line that failed stays on the record, marked with the time.
ALTER TABLE "VascularAccess" ADD COLUMN "failed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "failedAt" TIMESTAMP(3),
ADD COLUMN "insertedAt" TIMESTAMP(3);
