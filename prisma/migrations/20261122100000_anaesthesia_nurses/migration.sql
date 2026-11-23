-- Anaesthesia nurses (10.8.0): a role, the nurses of a case (any number),
-- a nurse on a theatre for a day, and the planned date of the operation.
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'ANAESTHESIA_NURSE';

ALTER TABLE "Case" ADD COLUMN "plannedSurgeryDate" DATE;

CREATE TYPE "CaseNurseSource" AS ENUM ('ASSIGNED', 'THEATRE', 'HANDOVER');

CREATE TABLE "CaseNurse" (
    "caseId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assignedById" TEXT,
    "source" "CaseNurseSource" NOT NULL DEFAULT 'ASSIGNED',
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseNurse_pkey" PRIMARY KEY ("caseId","userId")
);

CREATE INDEX "CaseNurse_userId_idx" ON "CaseNurse"("userId");

ALTER TABLE "CaseNurse" ADD CONSTRAINT "CaseNurse_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CaseNurse" ADD CONSTRAINT "CaseNurse_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CaseNurse" ADD CONSTRAINT "CaseNurse_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "TheatreNurseShift" (
    "id" TEXT NOT NULL,
    "theatreId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "shiftDate" DATE NOT NULL,
    "assignedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TheatreNurseShift_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TheatreNurseShift_theatreId_userId_shiftDate_key" ON "TheatreNurseShift"("theatreId", "userId", "shiftDate");
CREATE INDEX "TheatreNurseShift_userId_shiftDate_idx" ON "TheatreNurseShift"("userId", "shiftDate");

ALTER TABLE "TheatreNurseShift" ADD CONSTRAINT "TheatreNurseShift_theatreId_fkey" FOREIGN KEY ("theatreId") REFERENCES "OperatingTheatre"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TheatreNurseShift" ADD CONSTRAINT "TheatreNurseShift_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TheatreNurseShift" ADD CONSTRAINT "TheatreNurseShift_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
