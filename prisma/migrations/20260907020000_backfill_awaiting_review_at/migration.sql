-- Backfill for cases that reached AWAITING_REVIEW before awaitingReviewAt
-- existed (migration 20260906180000_case_awaiting_review_at added it as
-- NULL for every existing row). The auto-close sweep only ever selects
-- `awaitingReviewAt IS NOT NULL`, so any such case would otherwise sit in
-- AWAITING_REVIEW forever, invisible to the sweep, with no client ever
-- re-stamping it (the stamp only happens on the transition INTO that status).
--
-- Stamped to NOW() rather than an inferred past instant (e.g. updatedAt):
-- this gives every backfilled case a full, fresh review window starting from
-- the migration itself, instead of some already being past their window and
-- closing on the very next sweep with no notice.
UPDATE "Case"
SET "awaitingReviewAt" = CURRENT_TIMESTAMP
WHERE "status" = 'AWAITING_REVIEW' AND "awaitingReviewAt" IS NULL;
