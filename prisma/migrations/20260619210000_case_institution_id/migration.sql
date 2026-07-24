-- v2.1: Store the case's institution at creation time for research attribution.
-- Nullable FK; existing cases retain NULL (institution readable from case.user.institutionId).
ALTER TABLE "Case" ADD COLUMN IF NOT EXISTS "institutionId" TEXT;

CREATE INDEX IF NOT EXISTS "Case_institutionId_idx" ON "Case" ("institutionId");

ALTER TABLE "Case"
  ADD CONSTRAINT "Case_institutionId_fkey"
  FOREIGN KEY ("institutionId") REFERENCES "Institution"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
