-- Rewrite User_username_format so a restored database matches a live one.
--
-- The rule is unchanged in meaning. Only its stored shape changes.
--
-- 20260823120000_deployment_username_identity wrote the length test as
-- `char_length("username") BETWEEN 3 AND 64`. PostgreSQL does not store
-- BETWEEN: it expands it into `(a >= 3 AND a <= 64)` as a *nested* AND node
-- inside the surrounding AND. pg_dump renders that nesting, and reloading the
-- dump re-parses it -- at which point the planner flattens the nested AND into
-- a single N-ary AND.
--
-- So a database built by running migrations and the same database restored
-- from its own backup differ by one pair of brackets:
--
--   live:     OR (((char_length >= 3) AND (char_length <= 64)) AND (regex) AND (lower = canonical))
--   restored: OR  ((char_length >= 3) AND (char_length <= 64)  AND (regex) AND (lower = canonical))
--
-- infra/postgres/restore.sh hashes `pg_dump --schema-only` and refuses the
-- restore when the two hashes differ, so every appliance carrying the original
-- migration failed restore validation with RESTORE_TEMP_SCHEMA_INCOMPATIBLE --
-- deterministically, and on the one path that matters, because
-- rollback_policy=backup-required makes restoring a verified backup the only
-- supported recovery from a failed update.
--
-- Writing the comparison out explicitly produces the same flattened tree the
-- reloaded database has, so live and restored now agree. The companion change
-- in restore.sh stops the check depending on rendered text at all, so a future
-- BETWEEN cannot reintroduce this.
ALTER TABLE "User"
  DROP CONSTRAINT IF EXISTS "User_username_format";

ALTER TABLE "User"
  ADD CONSTRAINT "User_username_format"
    CHECK (
      "username" IS NULL
      OR (
        char_length("username") >= 3
        AND char_length("username") <= 64
        AND "username" ~ '^[A-Za-z][A-Za-z0-9._-]{2,63}$'
        AND lower("username") = "usernameCanonical"
      )
    );
