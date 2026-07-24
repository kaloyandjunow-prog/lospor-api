-- CreateEnum
CREATE TYPE "LibraryCategory" AS ENUM ('POSITION', 'AIRWAY_MANAGEMENT', 'VASCULAR_ACCESS', 'TECHNIQUE', 'MONITORING', 'PREMED_DRUG', 'INTRAOP_EVENT', 'INTRAOP_DRUG', 'INTRAOP_INFUSION', 'INHALATIONAL_AGENT', 'INTRAOP_FLUID');

-- CreateTable
CREATE TABLE "OptionLibrary" (
    "id" TEXT NOT NULL,
    "category" "LibraryCategory" NOT NULL,
    "value" TEXT NOT NULL,
    "labelEn" TEXT NOT NULL,
    "labelBg" TEXT,
    "group" TEXT,
    "parentId" TEXT,
    "drugId" TEXT,
    "color" TEXT,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OptionLibrary_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OptionLibrary_category_active_sortOrder_idx" ON "OptionLibrary"("category", "active", "sortOrder");

-- CreateIndex
CREATE INDEX "OptionLibrary_parentId_idx" ON "OptionLibrary"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "OptionLibrary_category_value_key" ON "OptionLibrary"("category", "value");

-- AddForeignKey
ALTER TABLE "OptionLibrary" ADD CONSTRAINT "OptionLibrary_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "OptionLibrary"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OptionLibrary" ADD CONSTRAINT "OptionLibrary_drugId_fkey" FOREIGN KEY ("drugId") REFERENCES "Drug"("id") ON DELETE SET NULL ON UPDATE CASCADE;
