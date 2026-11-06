-- Account-wide settings need an atomic optimistic-concurrency token. Without
-- it, two clients could read the same JSON preferences and the later full
-- write would silently erase the earlier client's unrelated setting.
ALTER TABLE "User" ADD COLUMN "preferencesRevision" INTEGER NOT NULL DEFAULT 0;
