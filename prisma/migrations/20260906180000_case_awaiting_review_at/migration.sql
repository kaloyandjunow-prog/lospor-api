-- When a case first became AWAITING_REVIEW.
--
-- Set once, on the transition, never touched by a later edit that keeps the
-- case in that status. This is the anchor the pending-close countdown reads:
-- one server timestamp every client computes the same remaining time from,
-- replacing a per-browser local clock that could not be read by another
-- client or another route into the same case.
--
-- Nullable, and expected to be null for a case that has never reached that
-- status -- a draft, or one still in progress.
ALTER TABLE "Case"
  ADD COLUMN "awaitingReviewAt" TIMESTAMP(3);
