-- AddColumn: clientDraftId for offline case-creation idempotency
ALTER TABLE "Case" ADD COLUMN "clientDraftId" TEXT;

-- Unique constraint scoped per-user so draft IDs cannot collide across users
CREATE UNIQUE INDEX "Case_userId_clientDraftId_key" ON "Case"("userId", "clientDraftId");
