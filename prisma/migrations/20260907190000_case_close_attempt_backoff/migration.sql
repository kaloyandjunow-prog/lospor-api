-- The automatic-closure sweep takes the oldest 25 expired cases per run and
-- orders by awaitingReviewAt. A case it cannot close stays AWAITING_REVIEW with
-- that timestamp unchanged, so it was selected again on the next run, and the
-- one after, for ever. Twenty-five such cases at the head of the queue meant
-- the twenty-sixth was never examined at all, however complete it was: one
-- ward's incomplete paperwork could silently stop automatic closure for the
-- whole hospital, with nothing in the UI to say so.
--
-- Existing rows start at zero attempts and no backoff, which is exactly right:
-- nothing has been refused under this scheme yet, so nothing has anything to
-- wait out.

ALTER TABLE "Case"
  ADD COLUMN "closeAttemptCount"  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "closeNextAttemptAt" TIMESTAMP(3);

-- The sweep's own selection: expired, awaiting review, and not currently
-- backing off. Without this the added predicate turns the scan into a filter
-- over every awaiting-review row.
CREATE INDEX "Case_pending_close_idx"
  ON "Case" ("status", "awaitingReviewAt", "closeNextAttemptAt");
