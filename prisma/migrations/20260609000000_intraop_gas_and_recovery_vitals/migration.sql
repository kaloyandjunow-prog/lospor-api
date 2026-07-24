CREATE TABLE IF NOT EXISTS "Icd11Alias" (
    "id" TEXT NOT NULL,
    "bgTerm" TEXT NOT NULL,
    "enTerm" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Icd11Alias_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Icd11Alias_bgTerm_key" ON "Icd11Alias"("bgTerm");

CREATE INDEX IF NOT EXISTS "Case_status_idx" ON "Case"("status");
CREATE INDEX IF NOT EXISTS "Case_userId_createdAt_idx" ON "Case"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "CaseLock_expiresAt_idx" ON "CaseLock"("expiresAt");
CREATE INDEX IF NOT EXISTS "CaseTransfer_status_idx" ON "CaseTransfer"("status");
CREATE INDEX IF NOT EXISTS "CaseTransfer_toUserId_status_idx" ON "CaseTransfer"("toUserId", "status");
CREATE INDEX IF NOT EXISTS "AuditLog_userId_idx" ON "AuditLog"("userId");
CREATE INDEX IF NOT EXISTS "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

ALTER TABLE "PreoperativeAssessment"
ADD COLUMN IF NOT EXISTS "highRiskSurgery" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "rcriIschemicHeart" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "rcriCHF" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "rcriCVD" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "rcriInsulinDM" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "rcriCreatinine" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "apfelPONVHistory" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "apfelPostopOpioids" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "stopbangSnoring" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "stopbangTired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "stopbangObserved" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "stopbangBP" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS "stopbangNeck" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "IntraoperativeRecord"
ADD COLUMN IF NOT EXISTS "fgfLitersPerMin" DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS "carrierGas" TEXT,
ADD COLUMN IF NOT EXISTS "fio2Percent" DOUBLE PRECISION;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'IntraoperativeRecord_carrierGas_check'
    ) THEN
        ALTER TABLE "IntraoperativeRecord"
        ADD CONSTRAINT "IntraoperativeRecord_carrierGas_check"
        CHECK ("carrierGas" IS NULL OR "carrierGas" IN ('air', 'n2o'));
    END IF;
END $$;

ALTER TABLE "PostoperativeRecord"
ADD COLUMN IF NOT EXISTS "recoveryBpSystolic" INTEGER,
ADD COLUMN IF NOT EXISTS "recoveryBpDiastolic" INTEGER,
ADD COLUMN IF NOT EXISTS "recoveryHeartRate" INTEGER,
ADD COLUMN IF NOT EXISTS "recoverySpO2" DOUBLE PRECISION,
DROP COLUMN IF EXISTS "timeInRecoveryMin";
