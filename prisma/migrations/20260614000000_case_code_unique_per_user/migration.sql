-- DropIndex
DROP INDEX "Case_caseCode_key";

-- CreateIndex
CREATE UNIQUE INDEX "Case_userId_caseCode_key" ON "Case"("userId", "caseCode");
