import { describe, expect, it } from "vitest"
import {
  detectSectionConflicts,
  type ClientSectionClaim,
  type ConflictDetectionInput,
  type ServerSectionState,
} from "./_patch-conflicts"

const NOW = new Date("2026-09-06T12:00:00.000Z")
const EARLIER = new Date("2026-09-06T11:00:00.000Z")

const untouched: ClientSectionClaim = { touched: false, base: null, revision: null }

function input(overrides: {
  differentUser?: boolean
  preop?: { client?: Partial<ClientSectionClaim>; server?: ServerSectionState }
  postop?: { client?: Partial<ClientSectionClaim>; server?: ServerSectionState }
  intraop?: { client?: Partial<ClientSectionClaim>; server?: ServerSectionState }
}): ConflictDetectionInput {
  const section = (o?: { client?: Partial<ClientSectionClaim>; server?: ServerSectionState }) => ({
    client: { ...untouched, ...(o?.client ?? {}) },
    server: o?.server ?? null,
    serverVersionForResponse: (guard: string) => guard,
  })
  return {
    differentUser: overrides.differentUser ?? false,
    sections: {
      preop: section(overrides.preop),
      postop: section(overrides.postop),
      intraop: section(overrides.intraop),
    },
  }
}

describe("missing base timestamp", () => {
  /**
   * The point of scoping this guard to other users: a client that legitimately
   * sends no base header -- a fresh load, an older mobile flow -- must be able
   * to save its own case rather than 409 against itself forever.
   */
  it("does not fire for the case's own user", () => {
    expect(detectSectionConflicts(input({
      differentUser: false,
      preop: { client: { touched: true, base: null }, server: { syncRevision: 3, updatedAt: NOW } },
    }))).toEqual([])
  })

  it("fires for a different user writing a section that already exists", () => {
    const conflicts = detectSectionConflicts(input({
      differentUser: true,
      preop: { client: { touched: true, base: null }, server: { syncRevision: 3, updatedAt: NOW } },
    }))
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({
      section: "preop",
      reason: "missing_conflict_timestamp",
      serverRevision: 3,
      serverUpdatedAt: NOW.toISOString(),
    })
  })

  it("does not fire when there is no server row to overwrite", () => {
    expect(detectSectionConflicts(input({
      differentUser: true,
      preop: { client: { touched: true, base: null }, server: null },
    }))).toEqual([])
  })

  /**
   * The regression this guard's own precondition exists to prevent. A client
   * that sent a valid revision has given the server exactly what it needs to
   * judge staleness -- rejecting it here anyway, for the unrelated reason that
   * it also sent no base timestamp, would refuse a request the server could
   * perfectly well evaluate.
   */
  it("does not fire when the client sent a usable revision instead of a base timestamp", () => {
    expect(detectSectionConflicts(input({
      differentUser: true,
      preop: { client: { touched: true, base: null, revision: 3 }, server: { syncRevision: 3, updatedAt: NOW } },
    }))).toEqual([])
  })

  it("still fires when the revision sent was invalid, since that is not a usable revision", () => {
    const conflicts = detectSectionConflicts(input({
      differentUser: true,
      preop: { client: { touched: true, base: null, revision: "invalid" }, server: { syncRevision: 3, updatedAt: NOW } },
    }))
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].reason).toBe("missing_conflict_timestamp")
  })
})

describe("stale revision", () => {
  /**
   * This one deliberately applies to the owner too: the same clinician in two
   * tabs, or on a phone and a laptop, could otherwise silently overwrite their
   * own newer edit with an older one.
   */
  it("fires for the case's own user when their revision is behind", () => {
    const conflicts = detectSectionConflicts(input({
      differentUser: false,
      preop: { client: { touched: true, base: null, revision: 2 }, server: { syncRevision: 3, updatedAt: NOW } },
    }))
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({ section: "preop", clientRevision: 2, serverRevision: 3 })
  })

  it("stays quiet when the revisions agree", () => {
    expect(detectSectionConflicts(input({
      preop: { client: { touched: true, revision: 3 }, server: { syncRevision: 3, updatedAt: NOW } },
    }))).toEqual([])
  })

  it("ignores a revision the route already rejected as invalid", () => {
    expect(detectSectionConflicts(input({
      preop: { client: { touched: true, revision: "invalid" }, server: { syncRevision: 3, updatedAt: NOW } },
    }))).toEqual([])
  })
})

describe("stale base timestamp", () => {
  it("fires when the server row is newer than what the client based its edit on", () => {
    const conflicts = detectSectionConflicts(input({
      postop: { client: { touched: true, base: EARLIER.toISOString() }, server: { syncRevision: 1, updatedAt: NOW } },
    }))
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({ section: "postop", clientBase: EARLIER.toISOString() })
  })

  it("stays quiet when the client is up to date", () => {
    expect(detectSectionConflicts(input({
      postop: { client: { touched: true, base: NOW.toISOString() }, server: { syncRevision: 1, updatedAt: NOW } },
    }))).toEqual([])
  })

  // A revision is the stronger signal, so the timestamp fallback stands down
  // rather than reporting the same collision twice.
  it("defers to the revision guard when a revision was sent", () => {
    const conflicts = detectSectionConflicts(input({
      postop: {
        client: { touched: true, base: EARLIER.toISOString(), revision: 1 },
        server: { syncRevision: 1, updatedAt: NOW },
      },
    }))
    expect(conflicts).toEqual([])
  })
})

describe("collecting rather than returning early", () => {
  /**
   * The response reports the first conflict, but every one is collected so an
   * override that proceeds anyway has something to write down. These used to be
   * early returns, which meant `overrideConflict` did not merely skip the 409 --
   * it erased any record that a colleague's edit had been replaced at all.
   */
  it("reports every conflicting section, in guard order then section order", () => {
    const conflicts = detectSectionConflicts(input({
      differentUser: true,
      preop: { client: { touched: true, base: null }, server: { syncRevision: 3, updatedAt: NOW } },
      postop: { client: { touched: true, base: EARLIER.toISOString() }, server: { syncRevision: 1, updatedAt: NOW } },
      intraop: { client: { touched: true, base: EARLIER.toISOString(), revision: 4 }, server: { syncRevision: 9, updatedAt: NOW } },
    }))
    expect(conflicts.map(c => [c.section, c.reason])).toEqual([
      ["preop", "missing_conflict_timestamp"],
      ["intraop", "stale_revision"],
      ["postop", "stale_timestamp"],
    ])
  })

  /**
   * The other half of the same regression: before guard 1 required "no usable
   * revision", a client that sent a stale revision AND no base timestamp could
   * be reported twice for one section -- once as missing_base, once as
   * stale_revision -- and an override would then audit the same section under
   * two different reasons.
   */
  it("reports exactly one conflict for a section that could match more than one guard", () => {
    const conflicts = detectSectionConflicts(input({
      differentUser: true,
      preop: { client: { touched: true, base: null, revision: 2 }, server: { syncRevision: 3, updatedAt: NOW } },
    }))
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].reason).toBe("stale_revision")
  })

  it("says nothing about a section this request does not write", () => {
    expect(detectSectionConflicts(input({
      differentUser: true,
      preop: { client: { touched: false, base: null }, server: { syncRevision: 3, updatedAt: NOW } },
    }))).toEqual([])
  })
})

describe("the serverVersion echoed back", () => {
  // Intraop's stale-revision reply carries the revision; the other two guards
  // deliberately send the timestamp alone, and the route depends on that.
  it("tells the caller which guard fired so the shape can differ per guard", () => {
    const missing = detectSectionConflicts(input({
      differentUser: true,
      intraop: { client: { touched: true, base: null }, server: { syncRevision: 3, updatedAt: NOW } },
    }))
    expect(missing[0].serverVersion).toBe("missing_base")

    const stale = detectSectionConflicts(input({
      intraop: { client: { touched: true, revision: 2 }, server: { syncRevision: 3, updatedAt: NOW } },
    }))
    expect(stale[0].serverVersion).toBe("stale_revision")
  })
})
