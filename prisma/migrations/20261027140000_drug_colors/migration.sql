-- A hospital's own drug colours (10.0.0): a group's, or one drug's, which
-- overrides its group's. Only presentation; no case is rewritten, and an
-- empty table means the bundled colours.

-- CreateTable
CREATE TABLE "DrugColor" (
    "scope" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DrugColor_pkey" PRIMARY KEY ("scope","name")
);
