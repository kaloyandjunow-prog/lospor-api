/**
 * Stale-write detection for PATCH /v1/cases/:id.
 *
 * Split out of the route because this is the sync contract's sharp edge and it
 * is pure: given what the client claims to have based its edit on and what the
 * server currently holds, it decides whether the save would overwrite somebody
 * else's work. It lived inline in a 560-line handler, which is the last place
 * a rule this consequential should be read or changed.
 *
 * Three guards, deliberately scoped differently:
 *
 *  - **missing base timestamp** applies only across users. A client that
 *    legitimately sends no base header (a fresh load, an older mobile flow)
 *    must not 409 against its own case.
 *  - **stale revision** applies to everyone, including the case owner: the
 *    same person in two tabs or on two devices could otherwise silently
 *    overwrite themselves.
 *  - **stale timestamp** is the fallback for clients that send a base
 *    timestamp but no revision.
 *
 * Every conflict is collected rather than returned at the first hit. The
 * response still reports the first one, in the same order as before, but an
 * override that proceeds anyway has something to write to the audit log --
 * these used to be early returns, so `overrideConflict` did not merely skip
 * the 409, it erased any record that there had been a conflict at all.
 */

export type ConflictSection = "preop" | "postop" | "intraop"

/** Which of the three guards produced a conflict. */
export type ConflictGuard = "missing_base" | "stale_revision" | "stale_timestamp"

export type ConflictReason = "missing_conflict_timestamp" | "stale_revision" | "stale_timestamp"

export type DetectedConflict = {
  section: ConflictSection
  /**
   * Every guard sets its own reason -- none of the three is a fallback for
   * the others. This used to be optional and set only by the missing-base
   * guard, so the audit write downstream defaulted an absent reason to
   * "stale_revision", meaning a genuine stale-*timestamp* conflict (guard 3)
   * was logged under the wrong cause.
   */
  reason: ConflictReason
  serverVersion: unknown
  clientRevision: number | null
  clientBase: string | null
  serverRevision: number | null
  serverUpdatedAt: string | null
}

/** What the server currently holds for one section. */
export type ServerSectionState = {
  syncRevision: number | null
  updatedAt: Date | null
} | null | undefined

/** What the client claimed to be editing, per section. */
export type ClientSectionClaim = {
  /** True when this request writes the section at all. */
  touched: boolean
  /** `x-lospor-<section>-updated-at`, or null when not sent. */
  base: string | null
  /** Parsed revision header; "invalid" is rejected by the route before this runs. */
  revision: number | null | "invalid"
}

export type ConflictDetectionInput = {
  /** The stricter missing-timestamp guard only applies across users. */
  differentUser: boolean
  sections: Record<ConflictSection, {
    client: ClientSectionClaim
    server: ServerSectionState
    /**
     * What to echo back as `serverVersion`. Preop and postop return the whole
     * row; intraop returns only its timing, because its record carries the
     * entire timetable blob and a 409 body is not the place for it -- and
     * intraop's stale-revision reply carries the revision too, which the other
     * two guards deliberately omit. The guard is passed in so that difference
     * stays visible rather than being flattened by the extraction.
     */
    serverVersionForResponse: (guard: ConflictGuard) => unknown
  }>
}

const at = (value: Date | null | undefined) => value?.toISOString() ?? null

export function detectSectionConflicts(input: ConflictDetectionInput): DetectedConflict[] {
  const conflicts: DetectedConflict[] = []
  const order: ConflictSection[] = ["preop", "postop", "intraop"]

  const push = (
    section: ConflictSection,
    server: NonNullable<ServerSectionState>,
    serverVersion: unknown,
    extra: Pick<DetectedConflict, "clientRevision" | "clientBase" | "reason">,
  ) => {
    conflicts.push({
      section,
      reason: extra.reason,
      serverVersion,
      clientRevision: extra.clientRevision,
      clientBase: extra.clientBase,
      serverRevision: server.syncRevision,
      serverUpdatedAt: at(server.updatedAt),
    })
  }

  // Guard 1 -- missing base timestamp, across users only. Requires the client
  // to have sent no usable revision either: a client that provided a valid
  // revision has given the server exactly what guard 2 needs to judge
  // staleness, and must not be rejected here for the unrelated reason that it
  // also didn't send a timestamp. This is also what keeps the three guards
  // mutually exclusive per section -- partitioned by what the client actually
  // sent (revision / base-only / neither) -- so a single stale request can no
  // longer produce two different conflicts, under two different reasons, for
  // the same section.
  for (const section of order) {
    const { client, server, serverVersionForResponse } = input.sections[section]
    if (!input.differentUser || !client.touched || !server || client.base) continue
    if (client.revision != null && client.revision !== "invalid") continue
    push(section, server, serverVersionForResponse("missing_base"), {
      reason: "missing_conflict_timestamp",
      clientRevision: null,
      clientBase: null,
    })
  }

  // Guard 2 -- stale revision, for everyone.
  for (const section of order) {
    const { client, server, serverVersionForResponse } = input.sections[section]
    if (!client.touched || !server) continue
    if (client.revision == null || client.revision === "invalid") continue
    if (server.syncRevision === client.revision) continue
    push(section, server, serverVersionForResponse("stale_revision"), {
      reason: "stale_revision",
      clientRevision: client.revision,
      clientBase: client.base,
    })
  }

  // Guard 3 -- stale base timestamp, for clients that send no revision.
  for (const section of order) {
    const { client, server, serverVersionForResponse } = input.sections[section]
    if (!client.touched || !server || client.revision != null || !client.base) continue
    if (!server.updatedAt) continue
    if (server.updatedAt.getTime() <= new Date(client.base).getTime()) continue
    push(section, server, serverVersionForResponse("stale_timestamp"), {
      reason: "stale_timestamp",
      clientRevision: null,
      clientBase: client.base,
    })
  }

  return conflicts
}
