-- LOSPOR 1.2.0 account lifecycle and server-side session inventory.
-- Existing JWTs do not have the session-tracked claim and remain valid only
-- for their original (maximum eight-hour) lifetime. Every newly issued token
-- is backed by AuthSession and can be revoked immediately.

CREATE TYPE "AuthSessionClientType" AS ENUM ('WEB', 'NATIVE');

ALTER TABLE "User"
  ADD COLUMN "suspendedAt" TIMESTAMP(3),
  ADD COLUMN "recoveryRequiredAt" TIMESTAMP(3),
  ADD COLUMN "anonymizedAt" TIMESTAMP(3);

-- Older retention jobs used a stable sentinel email but had no explicit
-- terminal marker. Mark those rows so the restore route can fail closed.
UPDATE "User"
SET "anonymizedAt" = COALESCE("passwordChangedAt", "deletedAt", CURRENT_TIMESTAMP)
WHERE "email" LIKE 'deleted-%@lospor.invalid';

CREATE TABLE "AuthSession" (
  "jti" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "clientType" "AuthSessionClientType" NOT NULL,
  "deviceLabel" TEXT NOT NULL,
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "revokedReason" TEXT,
  CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("jti")
);

ALTER TABLE "AuthSession"
  ADD CONSTRAINT "AuthSession_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "AuthSession_userId_revokedAt_expiresAt_idx"
  ON "AuthSession"("userId", "revokedAt", "expiresAt");
CREATE INDEX "AuthSession_expiresAt_idx" ON "AuthSession"("expiresAt");
