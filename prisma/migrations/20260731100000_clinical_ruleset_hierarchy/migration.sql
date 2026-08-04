CREATE TYPE "ClinicalPresetScope" AS ENUM ('PLATFORM', 'INSTITUTION', 'USER');

ALTER TABLE "ClinicalPreset"
ADD COLUMN "clinicalMode" "ClinicalMode" NOT NULL DEFAULT 'PEDIATRIC',
ADD COLUMN "scope" "ClinicalPresetScope" NOT NULL DEFAULT 'PLATFORM',
ADD COLUMN "ownerInstitutionId" TEXT,
ADD COLUMN "ownerUserId" TEXT,
ADD COLUMN "copiedFromPresetId" TEXT,
ADD COLUMN "copiedFromVersion" INTEGER;

DROP INDEX IF EXISTS "ClinicalPreset_key_version_key";

-- Version identities are scoped to their owner. Partial indexes are required
-- because PostgreSQL otherwise treats the nullable owner columns as distinct.
CREATE UNIQUE INDEX "ClinicalPreset_platform_key_mode_version_key"
ON "ClinicalPreset"("key", "clinicalMode", "version")
WHERE "scope" = 'PLATFORM';

CREATE UNIQUE INDEX "ClinicalPreset_institution_key_mode_owner_version_key"
ON "ClinicalPreset"("key", "clinicalMode", "ownerInstitutionId", "version")
WHERE "scope" = 'INSTITUTION';

CREATE UNIQUE INDEX "ClinicalPreset_user_key_mode_owner_version_key"
ON "ClinicalPreset"("key", "clinicalMode", "ownerUserId", "version")
WHERE "scope" = 'USER';

CREATE INDEX "ClinicalPreset_scope_clinicalMode_status_idx"
ON "ClinicalPreset"("scope", "clinicalMode", "status");

CREATE INDEX "ClinicalPreset_ownerInstitutionId_clinicalMode_status_idx"
ON "ClinicalPreset"("ownerInstitutionId", "clinicalMode", "status");

CREATE INDEX "ClinicalPreset_ownerUserId_clinicalMode_status_idx"
ON "ClinicalPreset"("ownerUserId", "clinicalMode", "status");

CREATE INDEX "ClinicalPreset_copiedFromPresetId_idx"
ON "ClinicalPreset"("copiedFromPresetId");

ALTER TABLE "ClinicalPreset"
ADD CONSTRAINT "ClinicalPreset_ownerInstitutionId_fkey"
FOREIGN KEY ("ownerInstitutionId") REFERENCES "Institution"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ClinicalPreset"
ADD CONSTRAINT "ClinicalPreset_ownerUserId_fkey"
FOREIGN KEY ("ownerUserId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ClinicalPreset"
ADD CONSTRAINT "ClinicalPreset_copiedFromPresetId_fkey"
FOREIGN KEY ("copiedFromPresetId") REFERENCES "ClinicalPreset"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ClinicalPreset"
ADD CONSTRAINT "ClinicalPreset_scope_owner_check"
CHECK (
  ("scope" = 'PLATFORM' AND "ownerInstitutionId" IS NULL AND "ownerUserId" IS NULL)
  OR
  ("scope" = 'INSTITUTION' AND "ownerInstitutionId" IS NOT NULL AND "ownerUserId" IS NULL)
  OR
  ("scope" = 'USER' AND "ownerInstitutionId" IS NULL AND "ownerUserId" IS NOT NULL)
);

CREATE TABLE "PlatformClinicalPresetSelection" (
  "clinicalMode" "ClinicalMode" NOT NULL,
  "presetId" TEXT NOT NULL,
  "selectedById" TEXT,
  "selectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlatformClinicalPresetSelection_pkey" PRIMARY KEY ("clinicalMode")
);

CREATE TABLE "InstitutionClinicalPresetSelection" (
  "id" TEXT NOT NULL,
  "institutionId" TEXT NOT NULL,
  "clinicalMode" "ClinicalMode" NOT NULL,
  "presetId" TEXT NOT NULL,
  "selectedById" TEXT,
  "selectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "InstitutionClinicalPresetSelection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserClinicalPresetSelection" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "clinicalMode" "ClinicalMode" NOT NULL,
  "presetId" TEXT NOT NULL,
  "selectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UserClinicalPresetSelection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InstitutionClinicalPresetSelection_institutionId_clinicalMode_key"
ON "InstitutionClinicalPresetSelection"("institutionId", "clinicalMode");

CREATE UNIQUE INDEX "UserClinicalPresetSelection_userId_clinicalMode_key"
ON "UserClinicalPresetSelection"("userId", "clinicalMode");

INSERT INTO "PlatformClinicalPresetSelection" (
  "clinicalMode",
  "presetId",
  "selectedAt",
  "updatedAt"
)
SELECT
  'PEDIATRIC'::"ClinicalMode",
  "id",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "ClinicalPreset"
WHERE "id" = 'lospor-standard-v1'
ON CONFLICT ("clinicalMode") DO NOTHING;

INSERT INTO "InstitutionClinicalPresetSelection" (
  "id",
  "institutionId",
  "clinicalMode",
  "presetId",
  "selectedAt",
  "updatedAt"
)
SELECT
  'legacy-pediatric-' || "id",
  "id",
  'PEDIATRIC'::"ClinicalMode",
  "clinicalPresetId",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Institution"
WHERE "clinicalPresetId" IS NOT NULL
ON CONFLICT ("institutionId", "clinicalMode") DO NOTHING;

ALTER TABLE "Institution"
DROP CONSTRAINT IF EXISTS "Institution_clinicalPresetId_fkey";

ALTER TABLE "Institution"
DROP COLUMN "clinicalPresetId";

CREATE INDEX "PlatformClinicalPresetSelection_presetId_idx"
ON "PlatformClinicalPresetSelection"("presetId");

CREATE INDEX "InstitutionClinicalPresetSelection_presetId_idx"
ON "InstitutionClinicalPresetSelection"("presetId");

CREATE INDEX "UserClinicalPresetSelection_presetId_idx"
ON "UserClinicalPresetSelection"("presetId");

ALTER TABLE "PlatformClinicalPresetSelection"
ADD CONSTRAINT "PlatformClinicalPresetSelection_presetId_fkey"
FOREIGN KEY ("presetId") REFERENCES "ClinicalPreset"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PlatformClinicalPresetSelection"
ADD CONSTRAINT "PlatformClinicalPresetSelection_selectedById_fkey"
FOREIGN KEY ("selectedById") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "InstitutionClinicalPresetSelection"
ADD CONSTRAINT "InstitutionClinicalPresetSelection_institutionId_fkey"
FOREIGN KEY ("institutionId") REFERENCES "Institution"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "InstitutionClinicalPresetSelection"
ADD CONSTRAINT "InstitutionClinicalPresetSelection_presetId_fkey"
FOREIGN KEY ("presetId") REFERENCES "ClinicalPreset"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "InstitutionClinicalPresetSelection"
ADD CONSTRAINT "InstitutionClinicalPresetSelection_selectedById_fkey"
FOREIGN KEY ("selectedById") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "UserClinicalPresetSelection"
ADD CONSTRAINT "UserClinicalPresetSelection_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserClinicalPresetSelection"
ADD CONSTRAINT "UserClinicalPresetSelection_presetId_fkey"
FOREIGN KEY ("presetId") REFERENCES "ClinicalPreset"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
