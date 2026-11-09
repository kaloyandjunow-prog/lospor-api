-- The side of a block, and of a unilateral spinal (10.2.0).
--
-- Stored beside the technique list rather than inside it, by technique code:
-- {"BLOCK_FEMORAL": "LEFT", "SPINAL_UNILATERAL": "RIGHT"}. The sides are LEFT,
-- RIGHT and BOTH. Empty on every case saved before; those keep their
-- techniques exactly as they were, with no side, and are never rewritten.
ALTER TABLE "IntraoperativeRecord" ADD COLUMN "techniqueSides" JSONB NOT NULL DEFAULT '{}';
