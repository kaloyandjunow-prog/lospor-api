-- Asking to move to another institution.
--
-- Choosing an institution at registration stays self-service. Moving afterwards
-- does not: institutional membership is what lets a head of department see a
-- clinician's cases, so joining a department needs that department's consent.
--
-- Until now there was no way to change it at all. The self-service endpoint
-- refuses institutionId by design, and no admin route writes it either, so the
-- only route was direct database access.

CREATE TABLE "InstitutionChangeRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestedInstitutionId" TEXT NOT NULL,
    "previousInstitutionId" TEXT,
    "status" "RequestStatus" NOT NULL DEFAULT 'PENDING',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedById" TEXT,

    CONSTRAINT "InstitutionChangeRequest_pkey" PRIMARY KEY ("id")
);

-- Approvers list what is pending for the institution they are responsible for.
CREATE INDEX "InstitutionChangeRequest_status_requestedInstitutionId_idx"
    ON "InstitutionChangeRequest"("status", "requestedInstitutionId");

CREATE INDEX "InstitutionChangeRequest_userId_idx"
    ON "InstitutionChangeRequest"("userId");

ALTER TABLE "InstitutionChangeRequest"
    ADD CONSTRAINT "InstitutionChangeRequest_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Restrict, not cascade: an institution with an outstanding request to join it
-- should not disappear silently underneath that request.
ALTER TABLE "InstitutionChangeRequest"
    ADD CONSTRAINT "InstitutionChangeRequest_requestedInstitutionId_fkey"
    FOREIGN KEY ("requestedInstitutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
