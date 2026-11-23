-- Who was on a case, and when: an append-only history of the doctors and the nurses (2026-11-23).

CREATE TYPE "CaseStaffKind" AS ENUM ('DOCTOR', 'NURSE');
CREATE TYPE "CaseStaffAction" AS ENUM ('JOINED', 'LEFT');

CREATE TABLE "CaseStaffLog" (
  "id"       TEXT              NOT NULL,
  "caseId"   TEXT              NOT NULL,
  "userId"   TEXT              NOT NULL,
  "kind"     "CaseStaffKind"   NOT NULL,
  "action"   "CaseStaffAction" NOT NULL,
  "reason"   TEXT              NOT NULL,
  "byUserId" TEXT,
  "at"       TIMESTAMP(3)      NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CaseStaffLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CaseStaffLog_caseId_at_idx" ON "CaseStaffLog" ("caseId", "at");
CREATE INDEX "CaseStaffLog_userId_idx" ON "CaseStaffLog" ("userId");

ALTER TABLE "CaseStaffLog"
  ADD CONSTRAINT "CaseStaffLog_caseId_fkey"
  FOREIGN KEY ("caseId") REFERENCES "Case" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CaseStaffLog"
  ADD CONSTRAINT "CaseStaffLog_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CaseStaffLog"
  ADD CONSTRAINT "CaseStaffLog_byUserId_fkey"
  FOREIGN KEY ("byUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- What the database already knows, so the history is whole from the first day. These rows say BACKFILL where the
-- original reason was not recorded; times are the best the existing rows give.
-- Doctors: a case nobody transferred was its owner's from the start.
INSERT INTO "CaseStaffLog" ("id", "caseId", "userId", "kind", "action", "reason", "at")
SELECT gen_random_uuid()::text, c."id", c."userId", 'DOCTOR', 'JOINED', 'BACKFILL', c."createdAt"
FROM "Case" c
WHERE NOT EXISTS (SELECT 1 FROM "CaseTransfer" t WHERE t."caseId" = c."id" AND t."status" = 'ACCEPTED');

-- ... a transferred case began with the first transfer's sender, and each accepted transfer is a leaving and a joining.
INSERT INTO "CaseStaffLog" ("id", "caseId", "userId", "kind", "action", "reason", "at")
SELECT DISTINCT ON (t."caseId") gen_random_uuid()::text, t."caseId", t."fromUserId", 'DOCTOR', 'JOINED', 'BACKFILL', c."createdAt"
FROM "CaseTransfer" t JOIN "Case" c ON c."id" = t."caseId"
WHERE t."status" = 'ACCEPTED'
ORDER BY t."caseId", COALESCE(t."resolvedAt", t."createdAt") ASC;

INSERT INTO "CaseStaffLog" ("id", "caseId", "userId", "kind", "action", "reason", "byUserId", "at")
SELECT gen_random_uuid()::text, t."caseId", t."fromUserId", 'DOCTOR', 'LEFT', 'TRANSFER', t."initiatedBy", COALESCE(t."resolvedAt", t."createdAt")
FROM "CaseTransfer" t WHERE t."status" = 'ACCEPTED';

INSERT INTO "CaseStaffLog" ("id", "caseId", "userId", "kind", "action", "reason", "byUserId", "at")
SELECT gen_random_uuid()::text, t."caseId", t."toUserId", 'DOCTOR', 'JOINED', 'TRANSFER', t."initiatedBy", COALESCE(t."resolvedAt", t."createdAt")
FROM "CaseTransfer" t WHERE t."status" = 'ACCEPTED';

-- Nurses on a case now.
INSERT INTO "CaseStaffLog" ("id", "caseId", "userId", "kind", "action", "reason", "byUserId", "at")
SELECT gen_random_uuid()::text, n."caseId", n."userId", 'NURSE', 'JOINED', n."source"::text, n."assignedById", n."assignedAt"
FROM "CaseNurse" n;

-- Append-only, held by the database and not by callers: no row is ever changed or removed. Deleting the case itself (a draft
-- thrown away) takes its rows with it through the foreign key -- a nested delete, which the guard lets through.
CREATE OR REPLACE FUNCTION lospor_guard_case_staff_log()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'CASE_STAFF_LOG_IMMUTABLE' USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CaseStaffLog_guard_immutable"
BEFORE UPDATE OR DELETE ON "CaseStaffLog"
FOR EACH ROW
EXECUTE FUNCTION lospor_guard_case_staff_log();
