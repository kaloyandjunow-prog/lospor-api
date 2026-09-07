import { describe, expect, it } from "vitest"
import { computeNextStatus, shouldStampAwaitingReview } from "./_patch-status"

describe("computeNextStatus", () => {
  it("honours an explicit status from the request", () => {
    expect(computeNextStatus({
      currentStatus: "DRAFT", requestedStatus: "IN_PROGRESS", intraopStarted: false,
    })).toBe("IN_PROGRESS")
  })

  it("promotes a draft once intraop has actually started", () => {
    expect(computeNextStatus({
      currentStatus: "DRAFT", intraopStarted: true,
    })).toBe("IN_PROGRESS")
  })

  // Intraop data alone is not a start: a case can be part-documented before
  // anyone is in the room.
  it("leaves a draft alone when intraop carries no start time", () => {
    expect(computeNextStatus({
      currentStatus: "DRAFT", intraopStarted: false,
    })).toBeUndefined()
  })

  /**
   * The regression this function used to exist to prevent, now prevented by
   * removing the path entirely: postop completeness is no longer a reason
   * for a generic PATCH to promote a case. Both clients autosave postop
   * field-by-field, so "a postop object arrived" (or even "postop is fully
   * complete") is true well before the clinician has said they are done --
   * see submit-for-review, the one deliberate action that now owns this
   * transition.
   */
  it("never promotes to AWAITING_REVIEW on its own, however complete postop is", () => {
    expect(computeNextStatus({
      currentStatus: "IN_PROGRESS", intraopStarted: false,
    })).toBeUndefined()
  })

  /**
   * Status is monotonic. An autosave replaying an older payload, or a client
   * that still believes the case is a draft, must never walk a reviewed case
   * back to DRAFT and reopen it.
   */
  it("never moves a case backwards, even when asked explicitly", () => {
    expect(computeNextStatus({
      currentStatus: "AWAITING_REVIEW", requestedStatus: "DRAFT", intraopStarted: false,
    })).toBeUndefined()
    expect(computeNextStatus({
      currentStatus: "IN_PROGRESS", requestedStatus: "DRAFT", intraopStarted: false,
    })).toBeUndefined()
  })

  it("does not re-promote a case that is already there", () => {
    expect(computeNextStatus({
      currentStatus: "AWAITING_REVIEW", intraopStarted: true,
    })).toBeUndefined()
  })
})

describe("shouldStampAwaitingReview", () => {
  it("stamps on the genuine transition into review", () => {
    expect(shouldStampAwaitingReview("IN_PROGRESS", "AWAITING_REVIEW")).toBe(true)
  })

  /**
   * The countdown anchors to this timestamp, so a later edit that leaves the
   * case in AWAITING_REVIEW must not restart it -- correcting a typo two
   * minutes before auto-close would otherwise buy another thirty minutes.
   */
  it("does not re-stamp a case already awaiting review", () => {
    expect(shouldStampAwaitingReview("AWAITING_REVIEW", "AWAITING_REVIEW")).toBe(false)
  })

  it("does not stamp for any other transition", () => {
    expect(shouldStampAwaitingReview("DRAFT", "IN_PROGRESS")).toBe(false)
    expect(shouldStampAwaitingReview("IN_PROGRESS", undefined)).toBe(false)
  })
})
