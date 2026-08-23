-- Hospital deployments require clinical administrators to complete an
-- offline-capable TOTP second factor. The public demo leaves that deployment
-- capability disabled, but shares the schema so Hospital imports stay exact.
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "mfaTotpSecretCiphertext" TEXT,
  ADD COLUMN IF NOT EXISTS "mfaEnabledAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "mfaLastTotpStep" INTEGER;

CREATE TABLE IF NOT EXISTS "MfaLoginChallenge" (
  "id" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "clientType" "AuthSessionClientType" NOT NULL,
  "preferredLocale" TEXT NOT NULL,
  "deviceLabel" TEXT NOT NULL,
  "enrollmentSecretCiphertext" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MfaLoginChallenge_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MfaLoginChallenge_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "MfaLoginChallenge_tokenHash_key"
  ON "MfaLoginChallenge"("tokenHash");
CREATE INDEX IF NOT EXISTS "MfaLoginChallenge_userId_usedAt_expiresAt_idx"
  ON "MfaLoginChallenge"("userId", "usedAt", "expiresAt");
CREATE INDEX IF NOT EXISTS "MfaLoginChallenge_expiresAt_idx"
  ON "MfaLoginChallenge"("expiresAt");

CREATE TABLE IF NOT EXISTS "MfaRecoveryCode" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MfaRecoveryCode_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MfaRecoveryCode_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "MfaRecoveryCode_userId_codeHash_key"
  ON "MfaRecoveryCode"("userId", "codeHash");
CREATE INDEX IF NOT EXISTS "MfaRecoveryCode_userId_usedAt_idx"
  ON "MfaRecoveryCode"("userId", "usedAt");
