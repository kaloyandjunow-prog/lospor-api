-- Public accounts continue to use email. Hospital appliances use a separate,
-- case-preserving username plus a lowercase appliance-global lookup key.
ALTER TABLE "User"
  ADD COLUMN "username" TEXT,
  ADD COLUMN "usernameCanonical" TEXT,
  ADD COLUMN "activatedAt" TIMESTAMP(3);

-- Preserve every currently active public account exactly. Email verification
-- used to be the activation bit, so its historical timestamp is authoritative.
UPDATE "User"
SET "activatedAt" = "emailVerifiedAt"
WHERE "activatedAt" IS NULL
  AND "emailVerifiedAt" IS NOT NULL;

ALTER TABLE "User" ALTER COLUMN "email" DROP NOT NULL;

CREATE UNIQUE INDEX "User_usernameCanonical_key"
  ON "User"("usernameCanonical");

ALTER TABLE "User"
  ADD CONSTRAINT "User_login_identity_present"
    CHECK ("email" IS NOT NULL OR "usernameCanonical" IS NOT NULL),
  ADD CONSTRAINT "User_username_pair"
    CHECK (("username" IS NULL) = ("usernameCanonical" IS NULL)),
  ADD CONSTRAINT "User_username_format"
    CHECK (
      "username" IS NULL
      OR (
        char_length("username") BETWEEN 3 AND 64
        AND "username" ~ '^[A-Za-z][A-Za-z0-9._-]{2,63}$'
        AND lower("username") = "usernameCanonical"
      )
    );
