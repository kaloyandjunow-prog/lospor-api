ALTER TABLE "VascularAccess" ADD COLUMN "depthCm" TEXT;
ALTER TABLE "VascularAccess" ADD COLUMN "lumens" TEXT;
ALTER TABLE "VascularAccess" ADD COLUMN "preexisting" BOOLEAN NOT NULL DEFAULT false;
