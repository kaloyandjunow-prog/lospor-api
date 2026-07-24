-- Normalize all stored user emails to lower(trim(...)).
-- User.email is a case-sensitive unique column and the auth routes now
-- normalize input the same way; without this backfill, users who registered
-- with a capitalized email could no longer log in.
--
-- Guard first: if two existing rows differ only by case/whitespace, the
-- UPDATE would violate the unique constraint. Fail loudly so a human merges
-- the duplicate accounts instead of the migration corrupting either one.
DO $$
BEGIN
  IF EXISTS (
    SELECT lower(btrim(email))
    FROM "User"
    GROUP BY lower(btrim(email))
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'User emails differing only by case/whitespace exist - merge these accounts manually before applying this migration';
  END IF;
END $$;

UPDATE "User"
SET "email" = lower(btrim("email"))
WHERE "email" <> lower(btrim("email"));
