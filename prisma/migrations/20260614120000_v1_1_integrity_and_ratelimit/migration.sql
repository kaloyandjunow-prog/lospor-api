-- IntraoperativeRecord.updatedAt — enables intraop stale-write conflict detection.
-- DEFAULT CURRENT_TIMESTAMP backfills existing rows and covers inserts; Prisma's
-- @updatedAt bumps it on every update. IF NOT EXISTS tolerates dev-DB drift where
-- the column was already added via an earlier `db push`.
ALTER TABLE "IntraoperativeRecord"
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Shared, serverless-safe rate-limit store (replaces the in-memory Map).
CREATE TABLE IF NOT EXISTS "RateLimit" (
  "key"         TEXT NOT NULL,
  "count"       INTEGER NOT NULL,
  "windowStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RateLimit_pkey" PRIMARY KEY ("key")
);

CREATE INDEX IF NOT EXISTS "RateLimit_windowStart_idx" ON "RateLimit"("windowStart");
