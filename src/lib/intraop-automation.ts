import { Prisma, type PrismaClient } from "@/generated/prisma/client"
import {
  automationGroupEnabled,
  parseIntraopAutomation,
  vitalQuestionsEnabled,
  type IntraopAutomationSettings,
  type VitalBandKey,
  type VitalSignKey,
} from "@lospor/core/intraop-automation"
import { activeCaseLog, addEvent } from "@/lib/case-events"
import { addOutcomes, successionOverview, suggestionOutcomes, type SuccessionOverviewRow, type SuggestionCounts } from "@lospor/core/intraop-suggestions"
import { SEED_SUCCESSION, SEQUENCE_EVENTS, buildSuccessionStats, mergeSuccession, successionContext, type SuccessionCase, type SuccessionLink, type SuccessionStructuredRecords } from "@lospor/core/event-succession"
import { parseLogEvents, type LogEvent } from "@lospor/core/intraop-types"
import {
  isOpenVitalEpisode,
  lowestPressure,
  preopAgeDays,
  vitalBandFor,
  type VitalHistogram,
  type VitalStatsTable,
} from "@lospor/core/vital-questions"

/**
 * Intraoperative automation (10.1.0): the settings a hospital switches on in
 * Status, or the deployment-specific demo profile when no policy is saved,
 * and the readings its vitals questions are measured against.
 *
 * The statistics are counts per whole-number value, per age band and sign,
 * over every charted reading in scope (auto-filled copies excluded), all time.
 * Counting per value keeps the cost flat however many readings there are, and
 * no patient-level record leaves the server: a band's counts carry no case.
 */

type Db = PrismaClient | Prisma.TransactionClient

/** Analytics reads span several queries (case bands plus events, or cases plus
 * their clinical events). A repeatable-read snapshot keeps a completion or
 * event write that lands between those queries from producing a mixed answer.
 * The small in-memory stores used by unit tests do not expose `$transaction`,
 * so they retain their direct-query behaviour. */
async function repeatableRead<T>(db: Db, work: (snapshot: Db) => Promise<T>): Promise<T> {
  const client = db as PrismaClient
  if (typeof client.$transaction !== "function") return work(db)
  return client.$transaction(snapshot => work(snapshot), {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  })
}

const POLICY_ID = "local"

/** Case, policy and event writes call this so automation responses never hold stale derived data. */
export function invalidateIntraopAutomationCaches(): void {
  statsCache.clear()
  successionCache.clear()
  acceptanceCache.clear()
}

/**
 * The settings in force. Nothing saved (the public demo, which has no Status,
 * or an appliance before anyone opens Status) is Core's default: every
 * suggestion on. A hospital narrows it in Status.
 */
export async function readIntraopAutomation(db: Db): Promise<IntraopAutomationSettings> {
  const row = await db.intraopAutomationPolicy.findUnique({ where: { id: POLICY_ID } })
  return parseIntraopAutomation(row ? row.config : undefined)
}

/** Saves the settings; anything out of range falls back to its default (off). */
export async function saveIntraopAutomation(db: Db, value: unknown): Promise<IntraopAutomationSettings> {
  const settings = parseIntraopAutomation(value)
  await db.intraopAutomationPolicy.upsert({
    where: { id: POLICY_ID },
    create: { id: POLICY_ID, config: settings as unknown as Prisma.InputJsonValue },
    update: { config: settings as unknown as Prisma.InputJsonValue },
  })
  invalidateIntraopAutomationCaches()
  return settings
}

type BandCounts = Map<VitalBandKey, Map<VitalSignKey, { values: Map<number, number>; cases: Set<string> }>>

function add(counts: BandCounts, band: VitalBandKey, sign: VitalSignKey, value: number, n: number, caseId: string) {
  if (!Number.isFinite(value)) return
  let signs = counts.get(band)
  if (!signs) counts.set(band, signs = new Map())
  let entry = signs.get(sign)
  if (!entry) signs.set(sign, entry = { values: new Map(), cases: new Set() })
  const v = Math.round(value)
  entry.values.set(v, (entry.values.get(v) ?? 0) + n)
  entry.cases.add(caseId)
}

function toTable(counts: BandCounts): VitalStatsTable {
  const table: VitalStatsTable = {}
  for (const [band, signs] of counts) {
    const out: Partial<Record<VitalSignKey, VitalHistogram>> = {}
    for (const [sign, entry] of signs) {
      const values = [...entry.values.keys()]
      if (values.length === 0) continue
      const min = Math.min(...values)
      const max = Math.max(...values)
      const histogram = Array.from({ length: max - min + 1 }, (_, index) => entry.values.get(min + index) ?? 0)
      out[sign] = { min, counts: histogram, cases: entry.cases.size }
    }
    table[band] = out
  }
  return table
}

type BpRow = {
  caseId: string
  systolic: number | null
  diastolic: number | null
  ibpSystolic: number | null
  ibpDiastolic: number | null
  ibpMap: number | null
  nibpMap: number | null
  month: Date | null
  n: number
}
type HrRow = { caseId: string; heartRate: number; month: Date | null; n: number }

/** The band of every case in scope that has started, from the patient's age. */
async function caseBands(db: Db, scope: Prisma.CaseWhereInput): Promise<Map<string, VitalBandKey>> {
  const cases = await db.case.findMany({
    where: { AND: [scope, { status: "COMPLETE" }, { intraop: { startedAt: { not: null } } }] },
    select: { id: true, preop: { select: { ageValue: true, ageUnit: true, ageYears: true, ageApproxDays: true } } },
  })
  const bands = new Map<string, VitalBandKey>()
  for (const item of cases) {
    const band = vitalBandFor(preopAgeDays(item.preop))
    if (band) bands.set(item.id, band.key)
  }
  return bands
}

async function readingRows(db: Db, caseIds: string[], byMonth: boolean): Promise<{ bp: BpRow[]; hr: HrRow[] }> {
  if (caseIds.length === 0) return { bp: [], hr: [] }
  const month = byMonth ? Prisma.sql`date_trunc('month', "timestamp")` : Prisma.sql`NULL::timestamp`
  // `metadataJson` is intentionally passthrough-compatible. Compare the JSON
  // text instead of casting it directly: an old/imported event containing
  // autoFilled="yes" must not take the whole automation endpoint down.
  const notCopied = Prisma.sql`("metadataJson"->>'autoFilled') IS DISTINCT FROM 'true'`
  const bp = await db.$queryRaw<BpRow[]>`
    SELECT "caseId", systolic, diastolic, "ibpSystolic", "ibpDiastolic", "ibpMap", "nibpMap", ${month} AS month, COUNT(*)::int AS n
    FROM "CaseEvent"
    WHERE type = 'vital' AND status = 'active' AND "caseId" = ANY(${caseIds})
      AND (systolic IS NOT NULL OR diastolic IS NOT NULL OR "ibpSystolic" IS NOT NULL OR "ibpDiastolic" IS NOT NULL OR "ibpMap" IS NOT NULL OR "nibpMap" IS NOT NULL) AND ${notCopied}
    GROUP BY 1, 2, 3, 4, 5, 6, 7, 8`
  const hr = await db.$queryRaw<HrRow[]>`
    SELECT "caseId", "heartRate", ${month} AS month, COUNT(*)::int AS n
    FROM "CaseEvent"
    WHERE type = 'vital' AND status = 'active' AND "caseId" = ANY(${caseIds})
      AND "heartRate" IS NOT NULL AND ${notCopied}
    GROUP BY 1, 2, 3`
  return { bp, hr }
}

function countRows(counts: BandCounts, bands: Map<string, VitalBandKey>, rows: { bp: BpRow[]; hr: HrRow[] }) {
  for (const row of rows.bp) {
    const band = bands.get(row.caseId)
    if (!band) continue
    const pressure = lowestPressure({
      systolic: row.systolic ?? undefined,
      diastolic: row.diastolic ?? undefined,
      ibpSystolic: row.ibpSystolic ?? undefined,
      ibpDiastolic: row.ibpDiastolic ?? undefined,
      ibpMap: row.ibpMap ?? undefined,
      nibpMap: row.nibpMap ?? undefined,
    })
    if (pressure.sbp != null) add(counts, band, "sbp", pressure.sbp, row.n, row.caseId)
    if (pressure.dbp != null) add(counts, band, "dbp", pressure.dbp, row.n, row.caseId)
    if (pressure.map != null) add(counts, band, "map", pressure.map, row.n, row.caseId)
  }
  for (const row of rows.hr) {
    const band = bands.get(row.caseId)
    if (band) add(counts, band, "hr", row.heartRate, row.n, row.caseId)
  }
}

const STATS_TTL_MS = 10 * 60_000
const statsCache = new Map<string, { at: number; stats: VitalStatsTable }>()

/**
 * Every band's reading counts in scope, all time. Kept ten minutes: limits move slowly.
 *
 * Read from the running tally when the scope is one institution or one
 * clinician (what the apps ask for), so the cost does not grow with the
 * database. Any other scope, and a test double without raw writes, counts the
 * readings directly; both give the same table.
 */
export async function vitalStats(db: Db, scope: Prisma.CaseWhereInput, now = Date.now()): Promise<VitalStatsTable> {
  const key = JSON.stringify(scope)
  const cached = statsCache.get(key)
  if (cached && now - cached.at < STATS_TTL_MS) return cached.stats
  const scopeKey = tallyScopeKey(scope)
  const stats = scopeKey && typeof (db as PrismaClient).$executeRaw === "function"
    ? await tallyStats(db, scopeKey)
    : await countedStats(db, scope)
  statsCache.set(key, { at: now, stats })
  return stats
}

/** The counts worked out from every reading: the reference the tally must agree with. */
export async function countedStats(db: Db, scope: Prisma.CaseWhereInput): Promise<VitalStatsTable> {
  return repeatableRead(db, async snapshot => {
    const bands = await caseBands(snapshot, scope)
    const counts: BandCounts = new Map()
    countRows(counts, bands, await readingRows(snapshot, [...bands.keys()], false))
    return toTable(counts)
  })
}

/* ---------- the running tally (10.2.0) ---------- */

type TallyContribution = { band: VitalBandKey; signs: Partial<Record<VitalSignKey, Record<string, number>>> }

/** The tally key for the scopes the apps use (indicatorScope): one institution, or one clinician without one. */
export function tallyScopeKey(scope: Prisma.CaseWhereInput): string | null {
  const keys = Object.keys(scope)
  if (keys.length !== 1) return null
  if (typeof scope.institutionId === "string") return `institution:${scope.institutionId}`
  if (typeof scope.userId === "string") return `user:${scope.userId}`
  return null
}

const caseTallyScopeKey = (item: { institutionId: string | null; userId: string }) =>
  item.institutionId ? `institution:${item.institutionId}` : `user:${item.userId}`

/** What one finalised case adds: its band, and per sign how many readings of each value. Null when it has no band. */
async function caseContribution(db: Db, caseId: string): Promise<{ scopeKey: string; contribution: TallyContribution | null } | null> {
  const item = await db.case.findUnique({
    where: { id: caseId },
    select: {
      status: true, institutionId: true, userId: true,
      intraop: { select: { startedAt: true } },
      preop: { select: { ageValue: true, ageUnit: true, ageYears: true, ageApproxDays: true } },
    },
  })
  if (!item || item.status !== "COMPLETE") return null
  const scopeKey = caseTallyScopeKey(item)
  const band = item.intraop?.startedAt ? vitalBandFor(preopAgeDays(item.preop))?.key : undefined
  if (!band) return { scopeKey, contribution: null }
  const counts: BandCounts = new Map()
  countRows(counts, new Map([[caseId, band]]), await readingRows(db, [caseId], false))
  const signs: TallyContribution["signs"] = {}
  for (const [sign, entry] of counts.get(band) ?? []) {
    signs[sign] = Object.fromEntries([...entry.values].map(([value, n]) => [String(value), n]))
  }
  return { scopeKey, contribution: { band, signs } }
}

async function applyContribution(db: Db, scopeKey: string, contribution: TallyContribution, direction: 1 | -1): Promise<void> {
  const signs: string[] = []
  const values: number[] = []
  const counts: number[] = []
  const caseSigns: string[] = []
  for (const [sign, byValue] of Object.entries(contribution.signs)) {
    const entries = Object.entries(byValue ?? {})
    if (entries.length === 0) continue
    caseSigns.push(sign)
    for (const [value, n] of entries) {
      signs.push(sign)
      values.push(Number(value))
      counts.push(n * direction)
    }
  }
  if (caseSigns.length === 0) return
  await db.$executeRaw`
    INSERT INTO "VitalStatTally" ("scopeKey", "band", "sign", "value", "count")
    SELECT ${scopeKey}, ${contribution.band}, t.sign, t.value, t.n
    FROM unnest(${signs}::text[], ${values}::int[], ${counts}::int[]) AS t(sign, value, n)
    ON CONFLICT ("scopeKey", "band", "sign", "value") DO UPDATE SET "count" = "VitalStatTally"."count" + EXCLUDED."count"`
  await db.$executeRaw`
    INSERT INTO "VitalStatTallyScope" ("scopeKey", "band", "sign", "cases")
    SELECT ${scopeKey}, ${contribution.band}, t.sign, ${direction}
    FROM unnest(${caseSigns}::text[]) AS t(sign)
    ON CONFLICT ("scopeKey", "band", "sign") DO UPDATE SET "cases" = "VitalStatTallyScope"."cases" + EXCLUDED."cases"`
  if (direction < 0) {
    await db.$executeRaw`DELETE FROM "VitalStatTally" WHERE "scopeKey" = ${scopeKey} AND "band" = ${contribution.band} AND "count" <= 0`
    await db.$executeRaw`DELETE FROM "VitalStatTallyScope" WHERE "scopeKey" = ${scopeKey} AND "band" = ${contribution.band} AND "cases" <= 0`
  }
}

/**
 * Add one finalised case to the tally, once. Safe to call again or from two
 * places at once: the case's own row decides who adds it. Returns whether it
 * was added now.
 */
export async function tallyFinalisedCase(db: Db, caseId: string): Promise<boolean> {
  const client = db as PrismaClient
  const work = async (tx: Db) => {
    const found = await caseContribution(tx, caseId)
    if (!found) return false
    const inserted = await tx.$executeRaw`
      INSERT INTO "VitalStatTallyCase" ("caseId", "scopeKey", "contribution")
      VALUES (${caseId}, ${found.scopeKey}, ${found.contribution ? JSON.stringify(found.contribution) : null}::jsonb)
      ON CONFLICT ("caseId") DO NOTHING`
    if (inserted === 0) return false
    if (found.contribution) await applyContribution(tx, found.scopeKey, found.contribution, 1)
    return true
  }
  return typeof client.$transaction === "function" ? client.$transaction(tx => work(tx)) : work(db)
}

/** Take a case back out of the tally (finalisation undone). Call inside the transaction that reopens it. */
export async function untallyCase(db: Db, caseId: string): Promise<void> {
  const rows = await db.$queryRaw<Array<{ scopeKey: string; contribution: TallyContribution | null }>>`
    DELETE FROM "VitalStatTallyCase" WHERE "caseId" = ${caseId} RETURNING "scopeKey", "contribution"`
  const row = rows[0]
  if (row?.contribution) await applyContribution(db, row.scopeKey, row.contribution, -1)
}

/** The finalised cases in scope that the tally has not counted yet (data from before it, or a missed finalisation). */
async function untalliedCases(db: Db, scopeKey: string, limit: number): Promise<string[]> {
  const [kind, id] = [scopeKey.slice(0, scopeKey.indexOf(":")), scopeKey.slice(scopeKey.indexOf(":") + 1)]
  const owner = kind === "institution" ? Prisma.sql`c."institutionId" = ${id}` : Prisma.sql`c."userId" = ${id}`
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT c.id FROM "Case" c
    WHERE c.status = 'COMPLETE' AND ${owner}
      AND NOT EXISTS (SELECT 1 FROM "VitalStatTallyCase" t WHERE t."caseId" = c.id)
    LIMIT ${limit}`
  return rows.map(row => row.id)
}

const TALLY_BACKFILL_BATCH = 200

async function tallyStats(db: Db, scopeKey: string): Promise<VitalStatsTable> {
  // Catch up first: the first read after the update counts the existing cases
  // once, and a case finalised by the pending-close sweep is picked up here.
  for (;;) {
    const pending = await untalliedCases(db, scopeKey, TALLY_BACKFILL_BATCH)
    if (pending.length === 0) break
    let added = 0
    for (const caseId of pending) if (await tallyFinalisedCase(db, caseId)) added += 1
    if (added === 0) break
  }
  return repeatableRead(db, async snapshot => {
    const rows = await snapshot.$queryRaw<Array<{ band: string; sign: string; value: number; count: number }>>`
      SELECT "band", "sign", "value", "count" FROM "VitalStatTally" WHERE "scopeKey" = ${scopeKey} AND "count" > 0`
    const cases = await snapshot.$queryRaw<Array<{ band: string; sign: string; cases: number }>>`
      SELECT "band", "sign", "cases" FROM "VitalStatTallyScope" WHERE "scopeKey" = ${scopeKey} AND "cases" > 0`
    return tallyTable(rows, cases)
  })
}

/** The table the apps read, from the tally's rows. */
export function tallyTable(
  rows: ReadonlyArray<{ band: string; sign: string; value: number; count: number }>,
  cases: ReadonlyArray<{ band: string; sign: string; cases: number }>,
): VitalStatsTable {
  const counts: BandCounts = new Map()
  for (const row of rows) {
    const band = row.band as VitalBandKey
    let signs = counts.get(band)
    if (!signs) counts.set(band, signs = new Map())
    let entry = signs.get(row.sign as VitalSignKey)
    if (!entry) signs.set(row.sign as VitalSignKey, entry = { values: new Map(), cases: new Set() })
    entry.values.set(Number(row.value), (entry.values.get(Number(row.value)) ?? 0) + Number(row.count))
  }
  const table = toTable(counts)
  for (const row of cases) {
    const histogram = table[row.band as VitalBandKey]?.[row.sign as VitalSignKey]
    if (histogram) histogram.cases = Number(row.cases)
  }
  return table
}

/**
 * How the counts grew, month by month: for each of the last `months` months,
 * every reading up to that month's end. Status draws how the limits moved
 * from it.
 */
export async function vitalStatsHistory(
  db: Db,
  scope: Prisma.CaseWhereInput,
  months = 24,
  now = new Date(),
): Promise<{ month: string; stats: VitalStatsTable }[]> {
  return repeatableRead(db, async snapshot => {
    const bands = await caseBands(snapshot, scope)
    const rows = await readingRows(snapshot, [...bands.keys()], true)
    const monthKey = (date: Date) => date.toISOString().slice(0, 7)
    const firstMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1))
    const counts: BandCounts = new Map()
    const before = (row: { month: Date | null }) => row.month != null && row.month < firstMonth
    countRows(counts, bands, { bp: rows.bp.filter(before), hr: rows.hr.filter(before) })
    const history: { month: string; stats: VitalStatsTable }[] = []
    for (let index = 0; index < months; index += 1) {
      const month = new Date(Date.UTC(firstMonth.getUTCFullYear(), firstMonth.getUTCMonth() + index, 1))
      const key = monthKey(month)
      const inMonth = (row: { month: Date | null }) => row.month != null && monthKey(row.month) === key
      countRows(counts, bands, { bp: rows.bp.filter(inMonth), hr: rows.hr.filter(inMonth) })
      history.push({ month: key, stats: toTable(counts) })
    }
    return history
  })
}

/**
 * How events were logged (10.2.0): per technique family, which sequence event followed which in the finished cases in
 * scope, with the usual gap. Only event names, their order and the gaps are read; no case, patient or clinician is
 * named in what comes out. Kept ten minutes like the vitals counts.
 */
const SUCCESSION_CASES_MAX = 20_000
const SUCCESSION_BATCH = 1_000
const successionCache = new Map<string, { at: number; links: SuccessionLink[] }>()

export async function learnedSuccession(db: Db, scope: Prisma.CaseWhereInput, now = Date.now()): Promise<SuccessionLink[]> {
  const key = JSON.stringify(scope)
  const cached = successionCache.get(key)
  if (cached && now - cached.at < STATS_TTL_MS) return cached.links
  const links = await repeatableRead(db, async snapshot => {
    const cases = await snapshot.case.findMany({
    where: { AND: [scope, { status: "COMPLETE" }, { intraop: { startedAt: { not: null } } }] },
    select: { id: true, clinicalMode: true, intraop: { select: { techniques: true, airwayDeviceEntries: true, vascularAccesses: true } } },
    orderBy: { createdAt: "desc" },
    take: SUCCESSION_CASES_MAX,
    })
    const byCase = new Map<string, SuccessionCase>()
    for (const item of cases) {
      const techniques = Array.isArray(item.intraop?.techniques) ? (item.intraop!.techniques as unknown[]).filter((value): value is string => typeof value === "string") : []
      byCase.set(item.id, {
        context: successionContext(techniques, item.clinicalMode === "PEDIATRIC"),
        events: [],
        structured: {
          airway: Array.isArray(item.intraop?.airwayDeviceEntries) ? item.intraop!.airwayDeviceEntries as SuccessionStructuredRecords["airway"] : [],
          vascular: Array.isArray(item.intraop?.vascularAccesses) ? item.intraop!.vascularAccesses as SuccessionStructuredRecords["vascular"] : [],
        },
      })
    }
    const ids = [...byCase.keys()]
    const events = [...SEQUENCE_EVENTS]
    for (let offset = 0; offset < ids.length; offset += SUCCESSION_BATCH) {
      const rows = await snapshot.caseEvent.findMany({
        where: { caseId: { in: ids.slice(offset, offset + SUCCESSION_BATCH) }, status: "active", type: "clinical_event", label: { in: events } },
        select: { caseId: true, logicalId: true, label: true, timestamp: true, metadataJson: true },
      })
      for (const row of rows) {
        if (row.label) {
          const metadata = row.metadataJson && typeof row.metadataJson === "object" && !Array.isArray(row.metadataJson)
            ? row.metadataJson as Record<string, unknown>
            : null
          const id = typeof metadata?.id === "string" && metadata.id ? metadata.id : row.logicalId
          ;(byCase.get(row.caseId)!.events as Array<{ label: string; ts: string; id?: string }>).push({ label: row.label, ts: row.timestamp.toISOString(), id })
        }
      }
    }
    return buildSuccessionStats([...byCase.values()])
  })
  successionCache.set(key, { at: now, links })
  return links
}

/** The links the apps use: the starting values, with each starting event replaced once its cases have been seen often enough. */
export async function successionForClient(db: Db, scope: Prisma.CaseWhereInput): Promise<SuccessionLink[]> {
  return mergeSuccession(SEED_SUCCESSION, await learnedSuccession(db, scope))
}

/**
 * What "Likely now" works from, for Status (10.2.0): every link, starting or learned, with how many of the site's
 * finished cases it rests on. Counts only, no case or clinician. Whole site: the hospital API passes its scope.
 */
export async function successionOverviewForStatus(db: Db, scope: Prisma.CaseWhereInput = {}): Promise<SuccessionOverviewRow[]> {
  return successionOverview(await learnedSuccession(db, scope))
}

/**
 * What the apps read: the settings, and the counts the questions need when
 * the questions are on. Off, no counts are worked out or sent.
 */
export async function intraopAutomationForClient(
  db: Db,
  scope: Prisma.CaseWhereInput,
): Promise<{ settings: IntraopAutomationSettings; stats: VitalStatsTable | null; succession: SuccessionLink[] | null }> {
  const settings = await readIntraopAutomation(db)
  return {
    settings,
    stats: vitalQuestionsEnabled(settings) ? await vitalStats(db, scope) : null,
    // What usually comes next (10.2.0), sent only while the reminders are on.
    succession: automationGroupEnabled(settings, "reminders") ? await successionForClient(db, scope) : null,
  }
}

/**
 * How the suggestions were received (10.2.0): per automation, how often one was
 * acted on and how often it was put away, over the cases started in the last
 * `days` days. Worked out from the saved charts alone (see suggestionOutcomes),
 * kept ten minutes like the vitals counts. No case or clinician is named: the
 * counts carry no patient-level record.
 */
const ACCEPTANCE_CASES_MAX = 20_000
const ACCEPTANCE_BATCH = 200
const acceptanceCache = new Map<string, { at: number; value: SuggestionAcceptance }>()

export type SuggestionAcceptance = { days: number; cases: number; byId: SuggestionCounts }

export async function suggestionAcceptance(
  db: Db,
  days = 90,
  now = Date.now(),
  scope: Prisma.CaseWhereInput = {},
): Promise<SuggestionAcceptance> {
  const cacheKey = JSON.stringify({ days, scope })
  const cached = acceptanceCache.get(cacheKey)
  if (cached && now - cached.at < STATS_TTL_MS) return cached.value
  const since = new Date(now - days * 86_400_000)
  const value = await repeatableRead(db, async snapshot => {
    const cases = await snapshot.case.findMany({
      where: { AND: [scope, { status: "COMPLETE" }, { intraop: { startedAt: { gte: since } } }] },
      select: { id: true },
      orderBy: { createdAt: "desc" },
      take: ACCEPTANCE_CASES_MAX,
    })
    const byId: SuggestionCounts = {}
    for (let from = 0; from < cases.length; from += ACCEPTANCE_BATCH) {
      const ids = cases.slice(from, from + ACCEPTANCE_BATCH).map(item => item.id)
      const rows = await snapshot.caseEvent.findMany({
        where: { caseId: { in: ids }, status: "active" },
        select: { caseId: true, logicalId: true, version: true, metadataJson: true },
      })
      const latest = new Map<string, Map<string, { version: number; event: LogEvent }>>()
      for (const row of rows) {
        const events = latest.get(row.caseId) ?? new Map()
        latest.set(row.caseId, events)
        const current = events.get(row.logicalId)
        if (!current || row.version > current.version) events.set(row.logicalId, { version: row.version, event: row.metadataJson as LogEvent })
      }
      for (const events of latest.values()) {
        addOutcomes(byId, suggestionOutcomes([...events.entries()].map(([logicalId, entry]) => ({ ...entry.event, id: entry.event.id ?? logicalId }))))
      }
    }
    return { days, cases: cases.length, byId }
  })
  acceptanceCache.set(cacheKey, { at: now, value })
  return value
}

/**
 * Closes episodes from the vitals questions still open at the case end: the
 * screen that holds a case closes them as readings come back, but a case
 * ended automatically, or finalised from another screen, may still have one
 * open. Closed at the case end, the last instant the chart covers. Runs inside
 * the caller's transaction, before the case is finalised -- never after.
 */
export async function closeOpenVitalEpisodes(tx: Parameters<typeof addEvent>[0], caseId: string, endedAt: Date, userId: string, source: string): Promise<number> {
  // 10.2.0: the episodes from SpO2, EtCO2 and temperature close the same way.
  const open = parseLogEvents(await activeCaseLog(tx, caseId))
    .filter(event => isOpenVitalEpisode(event) || (event.type === "complication" && event.complicationSource === "readings" && !event.endTs))
  let closed = 0
  for (const episode of open) {
    if (Date.parse(episode.ts) > endedAt.getTime()) continue
    if (await addEvent(tx, caseId, userId, { ...episode, endTs: endedAt.toISOString() }, source)) closed += 1
  }
  return closed
}
