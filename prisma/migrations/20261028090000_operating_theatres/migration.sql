-- Operating theatres (10.0.0): a hospital's own list, named in Status, and an
-- optional theatre on each case, assigned until intraop starts. Off by
-- default; no case is backfilled.

-- CreateTable
CREATE TABLE "OperatingTheatre" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperatingTheatre_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperatingTheatrePolicy" (
    "id" TEXT NOT NULL DEFAULT 'local',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperatingTheatrePolicy_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Case" ADD COLUMN "operatingTheatreId" TEXT,
ADD COLUMN "operatingTheatreName" TEXT;

-- CreateIndex
CREATE INDEX "OperatingTheatre_active_sortOrder_idx" ON "OperatingTheatre"("active", "sortOrder");

-- CreateIndex
CREATE INDEX "Case_operatingTheatreId_idx" ON "Case"("operatingTheatreId");

-- AddForeignKey
ALTER TABLE "Case" ADD CONSTRAINT "Case_operatingTheatreId_fkey" FOREIGN KEY ("operatingTheatreId") REFERENCES "OperatingTheatre"("id") ON DELETE SET NULL ON UPDATE CASCADE;
