-- Who has a case open (10.8.0): a notice kept by each screen's heartbeat, nothing is locked by it.
CREATE TABLE "CasePresence" (
    "caseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CasePresence_pkey" PRIMARY KEY ("caseId","userId","deviceId")
);

CREATE INDEX "CasePresence_caseId_seenAt_idx" ON "CasePresence"("caseId", "seenAt");

ALTER TABLE "CasePresence" ADD CONSTRAINT "CasePresence_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CasePresence" ADD CONSTRAINT "CasePresence_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
