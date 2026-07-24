import { Prisma } from "@/generated/prisma/client"
import { calculateFluidTotals, fluidTotalsPatch } from "@lospor/core/intraop-totals"
import {
  INTRAOP_COLUMN_MS,
  gasFractions,
  projectIntraopEvents,
  reverseProjectIntraop,
} from "@lospor/core/intraop-engine"
import { parseLogEvents, type LegacyKeyEvents as CoreLegacyKeyEvents } from "@lospor/core/intraop-types"
import type {
  LogEvent,
  LegacyKeyEvents,
} from "@/types/timetable"

// ─────────────────────────────────────────────────────────────────────────────
// Phase E: CaseEvent rows are the source of truth for the intraop chart.
//
// Writes go through here: each add/edit/delete becomes append-only versioned
// rows (nothing is ever hard-deleted — edits supersede, deletes tombstone), then
// the legacy IntraoperativeRecord.keyEvents blob is REBUILT from the live rows as
// a cache. Every existing reader (web/mobile chart, printout, OMOP export) keeps
// reading keyEvents unchanged — only the thing that fills it changed.
// ─────────────────────────────────────────────────────────────────────────────

// Accepts both a transaction client (inside $transaction) and a plain PrismaClient
// so callers that skip transactions for pgbouncer compatibility can pass prisma directly.
type Tx = Prisma.TransactionClient | { caseEvent: Prisma.TransactionClient["caseEvent"]; intraoperativeRecord: Prisma.TransactionClient["intraoperativeRecord"] }

export type { LogEvent }

const INTRAOP_GLUCOSE_LOINC_CODE = "2345-7"
const INTRAOP_GLUCOSE_UNIT_CANON = "mmol/L"

// ─── Projection (moved verbatim from the events route) ───────────────────────
export function projectTimetable(log: LogEvent[], start: Date) {
  const parsed = parseLogEvents(log.map((event, index) => ({
    ...event,
    id: event.id ?? `legacy-${index}`,
  })))
  return projectIntraopEvents(parsed, { start })
}


/** `startedAt` is a real instant; legacy wall clocks are display-only. */
export type ChartAnchorSource = {
  startedAt?: Date | null
  startTime: Date | null
  createdAt: Date
}

/** The trusted instant represented by column zero, when one was persisted. */
export function chartAnchorFor(intraop: ChartAnchorSource | null): Date | null {
  return intraop?.startedAt ?? null
}

/** Fallback origin for legacy event logs that have no persisted start instant. */
function chartStartFrom(log: LogEvent[]): Date {
  const sorted = [...log].sort((a, b) => new Date(a.ts ?? 0).getTime() - new Date(b.ts ?? 0).getTime())
  return sorted[0]?.ts ? new Date(sorted[0].ts) : new Date()
}

export function resolveChartStart(
  intraop: ChartAnchorSource | null,
  log: LogEvent[],
): Date {
  return chartAnchorFor(intraop) ?? chartStartFrom(log)
}

// Stable, order-independent comparison so a resend of an unchanged event is a
// no-op (idempotent) while a genuine edit is detected as different.
function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable)
  if (v && typeof v === "object") {
    return Object.keys(v).sort().reduce((acc, k) => { acc[k] = stable((v as Record<string, unknown>)[k]); return acc }, {} as Record<string, unknown>)
  }
  return v
}
function sameContent(a: Record<string, unknown> | null | undefined, b: Record<string, unknown> | null | undefined): boolean {
  const sa: Record<string, unknown> = { ...(a ?? {}) }; const sb: Record<string, unknown> = { ...(b ?? {}) }
  delete sa.syncStatus; delete sb.syncStatus
  return JSON.stringify(stable(sa)) === JSON.stringify(stable(sb))
}

function buildRow(
  caseId: string,
  userId: string | null,
  ev: LogEvent,
  version: number,
  status: string,
  idempotencyKey: string,
  source: string,
) {
  const primary = ev.dose ?? ev.value ?? ev.rate ?? ev.volume
  // Typed vital columns (only for vital events) so vitals are queryable as columns.
  const isVital = ev.type === "vital"
  const isGas = ev.type === "gas_start" || ev.type === "gas_change"
  const isAgent = ev.type === "agent_start"
  const isClinicalEvent = ev.type === "clinical_event" || ev.type === "event"
  const numI = (v: unknown) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Math.round(Number(v)))
  const numF = (v: unknown) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v))
  const bgl = isVital ? numF(ev.bgl) : null
  const gas = isGas ? gasFractions(ev.carrierGas, ev.fio2) : null
  return {
    caseId,
    userId,
    logicalId:      ev.id ?? idempotencyKey,
    version,
    status,
    type:           ev.type ?? "unknown",
    timestamp:      ev.ts && !Number.isNaN(new Date(ev.ts).getTime()) ? new Date(ev.ts) : new Date(),
    label:          (ev.label ?? ev.name ?? null) as string | null,
    value:          primary != null ? String(primary) : null,
    unit:           ev.unit ?? null,
    systolic:       isVital ? numI(ev.systolic)  : null,
    diastolic:      isVital ? numI(ev.diastolic) : null,
    heartRate:      isVital ? numI(ev.heartRate) : null,
    spO2:           isVital ? numF(ev.spO2)      : null,
    etco2:          isVital ? numF(ev.etco2)     : null,
    temp:           isVital ? numF(ev.temp)      : null,
    bgl,
    bglLoincCode:   bgl != null ? INTRAOP_GLUCOSE_LOINC_CODE : null,
    bglUnitCanon:   bgl != null ? INTRAOP_GLUCOSE_UNIT_CANON : null,
    fgfLitersPerMin: isGas ? numF(ev.fgf) : null,
    carrierGas:      isGas ? ev.carrierGas ?? null : null,
    fio2Percent:     gas?.fio2 ?? null,
    fiAirPercent:    gas?.fiAir ?? null,
    fiN2OPercent:    gas?.fiN2O ?? null,
    metadataJson:   ev as object,
    source,
    sourceVersion:   "case-events-v1",
    schemaVersion:   "3.0.0",
    idempotencyKey,
    atcCode:        ev.atcCode ?? null,
    drugId:         ev.drugId ?? null,
    inn:            ev.inn ?? null,
    drugRoute:      ev.drugRoute ?? null,
    infId:          ev.infId ?? null,
    fluidId:        ev.fluidId ?? null,
    rate:           ev.rate != null ? String(ev.rate) : null,
    concentration:  ev.concentration ?? null,
    volume:         ev.volume != null ? String(ev.volume) : null,
    fluidCategory:  ev.category ?? null,
    agentPercent:   isAgent ? numF(ev.value) : null,
    clinicalEventCode: isClinicalEvent ? ev.value ?? null : null,
  }
}

// Reconstruct a log from the legacy projected arrays when a case has a
// keyEvents blob but no `log` (a case whose intraop data predates this app's
// event-sourced write path). Synthetic timestamps preserve the column layout
// so the rebuilt chart matches; `baseMs` should be the case's actual start
// (real calendar day + time-of-day), not an arbitrary epoch, so these rows
// remain chronologically meaningful for audit/sorting once mixed in with
// real-timestamped events.
export function reverseProject(keyEvents: LegacyKeyEvents, baseMs: number): LogEvent[] {
  return reverseProjectIntraop(keyEvents as CoreLegacyKeyEvents, baseMs)
}

export function snapshotLogForReconcile(
  keyEvents: LegacyKeyEvents,
  startedAtMs: number | null,
  nowMs = Date.now(),
): LogEvent[] | null {
  if (Array.isArray(keyEvents.log) && keyEvents.log.length > 0) return keyEvents.log
  if (startedAtMs === null) return null
  const projected = reverseProject(keyEvents, startedAtMs)
  const futureLimit = nowMs + INTRAOP_COLUMN_MS
  return projected.some(event => {
    const ts = typeof event.ts === "string" ? Date.parse(event.ts) : NaN
    return Number.isFinite(ts) && ts > futureLimit
  }) ? null : projected
}

function hasProjectedSnapshot(keyEvents: LegacyKeyEvents): boolean {
  return [
    keyEvents.vitals,
    keyEvents.drugs,
    keyEvents.infusions,
    keyEvents.fluids,
    keyEvents.agents,
    keyEvents.gasSettings,
    keyEvents.positions,
    keyEvents.phases,
    keyEvents.clinicalEvents,
  ].some(value => Array.isArray(value) && value.length > 0)
}

export function shouldPreserveUnanchoredSnapshot(
  startedAt: Date | null | undefined,
  keyEvents: LegacyKeyEvents,
): boolean {
  return !startedAt &&
    (keyEvents.legacyUnanchored === true ||
      ((!Array.isArray(keyEvents.log) || keyEvents.log.length === 0) &&
        hasProjectedSnapshot(keyEvents)))
}

// If a case has no CaseEvent rows yet (its intraop data predates the
// event-sourced write path), seed them from its existing keyEvents (log if
// present, else reverse-projected from the legacy column-indexed arrays) so
// the rebuild has a complete picture and nothing is lost on the first write.
export async function ensureBackfilled(tx: Tx, caseId: string): Promise<void> {
  const count = await tx.caseEvent.count({ where: { caseId } })
  if (count > 0) return

  const intra = await tx.intraoperativeRecord.findUnique({ where: { caseId }, select: { keyEvents: true, startedAt: true, startTime: true, createdAt: true } })
  const keyEvents = (intra?.keyEvents as LegacyKeyEvents | null) ?? {}
  let log: LogEvent[] = Array.isArray(keyEvents.log) ? keyEvents.log : []
  if (log.length === 0) {
    // The legacy format only ever stored a 5-minute column index, never a real
    // timestamp, so reconstructed timestamps hang off the same chart anchor the
    // projection uses — one definition of column 0, shared.
    const anchor = intra ? chartAnchorFor(intra) : null
    if (!anchor) return
    log = reverseProject(keyEvents, anchor.getTime())
  }

  for (const ev of log) {
    if (!ev?.id) continue
    // "backfill", not inferSource(ev.id) — these rows were never actually
    // submitted by either app, so attributing them to "mobile" by default
    // (inferSource's fallback) would be misleading for audit purposes.
    await tx.caseEvent.create({
      data: buildRow(caseId, null, ev, 1, "active", `${caseId}:${ev.id}`, "backfill"),
    })
  }
}

// Map of logicalId → { active row (or null), max version seen }.
async function indexRows(tx: Tx, caseId: string) {
  const rows = await tx.caseEvent.findMany({
    where:   { caseId },
    orderBy: { version: "desc" },
    select:  { id: true, logicalId: true, version: true, status: true, metadataJson: true },
  })
  const active = new Map<string, { id: string; metadataJson: LogEvent }>()
  const maxVer = new Map<string, number>()
  for (const r of rows) {
    if (!maxVer.has(r.logicalId)) maxVer.set(r.logicalId, r.version)
    if (r.status === "active" && !active.has(r.logicalId)) active.set(r.logicalId, { id: r.id, metadataJson: r.metadataJson as LogEvent })
  }
  return { active, maxVer }
}

// Add a single event. Returns true if a new active row was written, false if it
// was a no-op duplicate (idempotent retry).
export async function addEvent(tx: Tx, caseId: string, userId: string, ev: LogEvent, source: string): Promise<boolean> {
  await ensureBackfilled(tx, caseId)
  const logicalId = ev.id!
  const { active, maxVer } = await indexRows(tx, caseId)
  const cur = active.get(logicalId)

  if (cur) {
    if (sameContent(cur.metadataJson, ev)) return false      // idempotent retry
    await tx.caseEvent.update({ where: { id: cur.id }, data: { status: "superseded" } })
    const version = (maxVer.get(logicalId) ?? 1) + 1
    await tx.caseEvent.create({ data: buildRow(caseId, userId, ev, version, "active", `${caseId}:${logicalId}:v${version}`, source) })
    return true
  }

  const prev = maxVer.get(logicalId)
  const version = prev ? prev + 1 : 1
  const key = version === 1 ? `${caseId}:${logicalId}` : `${caseId}:${logicalId}:v${version}`
  await tx.caseEvent.create({ data: buildRow(caseId, userId, ev, version, "active", key, source) })
  return true
}

/** Tombstone one logical event. Repeating the same delete is a safe no-op. */
export async function deleteEvent(tx: Tx, caseId: string, logicalId: string): Promise<boolean> {
  await ensureBackfilled(tx, caseId)
  const { active } = await indexRows(tx, caseId)
  const current = active.get(logicalId)
  if (!current) return false
  await tx.caseEvent.update({ where: { id: current.id }, data: { status: "deleted" } })
  return true
}

/**
 * Atomically claim the section revision before a multi-statement event write.
 * A crashed request may leave a harmless revision gap, but another writer
 * cannot rebuild the timetable from an older event snapshot.
 */
export async function reserveIntraopRevision(
  tx: Tx,
  caseId: string,
  expectedRevision: number,
): Promise<boolean> {
  const result = await tx.intraoperativeRecord.updateMany({
    where: { caseId, syncRevision: expectedRevision },
    data: { syncRevision: { increment: 1 } },
  })
  return result.count === 1
}

// Reconcile the full client log into append-only rows: new ids inserted, changed
// content superseded, ids missing from the incoming log tombstoned.
export async function reconcileFullLog(tx: Tx, caseId: string, userId: string, incoming: LogEvent[], source: string): Promise<void> {
  await ensureBackfilled(tx, caseId)
  const incomingById = new Map<string, LogEvent>()
  for (const ev of incoming) if (ev.id) incomingById.set(ev.id, ev)

  const { active, maxVer } = await indexRows(tx, caseId)

  for (const [logicalId, ev] of incomingById) {
    const cur = active.get(logicalId)
    if (cur) {
      if (sameContent(cur.metadataJson, ev)) continue
      await tx.caseEvent.update({ where: { id: cur.id }, data: { status: "superseded" } })
      const version = (maxVer.get(logicalId) ?? 1) + 1
      await tx.caseEvent.create({ data: buildRow(caseId, userId, ev, version, "active", `${caseId}:${logicalId}:v${version}`, source) })
    } else {
      const prev = maxVer.get(logicalId)
      const version = prev ? prev + 1 : 1
      const key = version === 1 ? `${caseId}:${logicalId}` : `${caseId}:${logicalId}:v${version}`
      await tx.caseEvent.create({ data: buildRow(caseId, userId, ev, version, "active", key, source) })
    }
  }

  // Tombstone any active row whose logicalId is no longer in the client log.
  for (const [logicalId, cur] of active) {
    if (!incomingById.has(logicalId)) {
      await tx.caseEvent.update({ where: { id: cur.id }, data: { status: "deleted" } })
    }
  }
}

// Rebuild the keyEvents cache from the live (active) rows. This is what the
// chart, printout and exports read.
/**
 * Deterministic projection ordering: timestamp, then version, then logicalId.
 * Exported for tests — the projection (chart, protocol PDF, OMOP export) must
 * be identical across rebuilds regardless of DB row return order.
 */
export function sortLogDeterministic<T extends { version: number; logicalId: string; ev: LogEvent }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => {
    const tsDiff = new Date(a.ev.ts ?? 0).getTime() - new Date(b.ev.ts ?? 0).getTime()
    if (tsDiff !== 0) return tsDiff
    if (a.version !== b.version) return a.version - b.version
    return a.logicalId < b.logicalId ? -1 : a.logicalId > b.logicalId ? 1 : 0
  })
}

export async function rebuildProjection(
  tx: Tx,
  caseId: string,
  options: { revisionAlreadyReserved?: boolean } = {},
): Promise<void> {
  const rows = await tx.caseEvent.findMany({
    where:   { caseId, status: "active" },
    select:  { logicalId: true, version: true, metadataJson: true },
  })
  // At most one active row per logicalId by construction; keep the latest just in case.
  const byLogical = new Map<string, { version: number; logicalId: string; ev: LogEvent }>()
  for (const r of rows) {
    const prev = byLogical.get(r.logicalId)
    if (!prev || r.version > prev.version) byLogical.set(r.logicalId, { version: r.version, logicalId: r.logicalId, ev: r.metadataJson as LogEvent })
  }
  // Deterministic order: ts, then version, then logicalId. findMany has no
  // orderBy, so without the tie-breaks equal-ts events (e.g. two writers of
  // the same vitals column) would land in DB return order and the projected
  // value could flip between rebuilds.
  const log = sortLogDeterministic([...byLogical.values()]).map(entry => ({
    ...entry.ev,
    id: entry.ev.id ?? entry.logicalId,
    sequence: entry.version,
  }))

  // Column 0 is the entered start time, not the first thing that got charted.
  // Using the earliest event meant the stored projection disagreed with what the
  // web client drew locally, and the difference only became visible when another
  // device opened the case — the "timetable starts at the wrong time on reopen"
  // report. Fall back to the earliest event only when no start time exists.
  const intraopRec = await tx.intraoperativeRecord.findUnique({
    where:  { caseId },
    select: {
      startedAt: true,
      startTime: true,
      createdAt: true,
      keyEvents: true,
      crystalloidsMl: true,
      colloidsMl: true,
      bloodMl: true,
    },
  })
  const existingKeyEvents = (intraopRec?.keyEvents as LegacyKeyEvents | null) ?? {}
  const preserveUnanchored = shouldPreserveUnanchoredSnapshot(
    intraopRec?.startedAt,
    existingKeyEvents,
  )
  const start = resolveChartStart(intraopRec, log)
  const projected = preserveUnanchored ? existingKeyEvents : projectTimetable(log, start)

  // The projected shape is a real, JSON-serializable plain object — optional
  // fields just don't structurally match Prisma's InputJsonValue (which
  // disallows `undefined`), hence the cast rather than a real mismatch.
  const keyEvents = {
    ...projected,
    log,
    ...(preserveUnanchored ? { legacyUnanchored: true } : {}),
  } as unknown as Prisma.InputJsonValue
  // Fluid totals are derived from the fluid events, so they are computed here
  // (the single source of truth) rather than PATCHed separately by each client
  // — the case-PATCH mapper no longer accepts them. Same core function both
  // apps used, so values are identical to before, just server-authoritative.
  const fluidTotals = fluidTotalsPatch(calculateFluidTotals(projected.fluids))
  const projectionUnchanged = !!intraopRec
    && sameContent(
      intraopRec.keyEvents as Record<string, unknown>,
      keyEvents as unknown as Record<string, unknown>,
    )
    && intraopRec.crystalloidsMl === fluidTotals.crystalloidsMl
    && intraopRec.colloidsMl === fluidTotals.colloidsMl
    && intraopRec.bloodMl === fluidTotals.bloodMl
  if (projectionUnchanged) return

  await tx.intraoperativeRecord.upsert({
    where:  { caseId },
    update: {
      keyEvents,
      ...fluidTotals,
      ...(options.revisionAlreadyReserved ? {} : { syncRevision: { increment: 1 } }),
    },
    // No start time: logging an event does not mean the clinician has told us
    // when the case began. This used to plant a midnight sentinel, which — being
    // a truthy Date — read downstream as a genuine 00:00 start and locked the
    // form with no way back.
    create: { caseId, startTime: null, keyEvents, ...fluidTotals, syncRevision: 1 },
  })
}
