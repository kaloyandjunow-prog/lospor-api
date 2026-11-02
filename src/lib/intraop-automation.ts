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
import { addOutcomes, suggestionOutcomes, type SuggestionCounts } from "@lospor/core/intraop-suggestions"
import { SEED_SUCCESSION, SEQUENCE_EVENTS, buildSuccessionStats, mergeSuccession, successionContext, type SuccessionCase, type SuccessionLink } from "@lospor/core/event-succession"
import { parseLogEvents, type LogEvent } from "@lospor/core/intraop-types"
import {
  isOpenVitalEpisode,
  meanArterialPressure,
  preopAgeDays,
  vitalBandFor,
  type VitalHistogram,
  type VitalStatsTable,
} from "@lospor/core/vital-questions"

/**
 * Intraoperative automation (10.1.0): the settings a hospital switches on in
 * Status, and the readings its vitals questions are measured against.
 *
 * The statistics are counts per whole-number value, per age band and sign,
 * over every charted reading in scope (auto-filled copies excluded), all time.
 * Counting per value keeps the cost flat however many readings there are, and
 * no patient-level record leaves the server: a band's counts carry no case.
 */

type Db = PrismaClient | Prisma.TransactionClient

const POLICY_ID = "local"

export async function readIntraopAutomation(db: Db): Promise<IntraopAutomationSettings> {
  const row = await db.intraopAutomationPolicy.findUnique({ where: { id: POLICY_ID } })
  return parseIntraopAutomation(row?.config)
}

/** Saves the settings; anything out of range falls back to its default (off). */
export async function saveIntraopAutomation(db: Db, value: unknown): Promise<IntraopAutomationSettings> {
  const settings = parseIntraopAutomation(value)
  await db.intraopAutomationPolicy.upsert({
    where: { id: POLICY_ID },
    create: { id: POLICY_ID, config: settings as unknown as Prisma.InputJsonValue },
    update: { config: settings as unknown as Prisma.InputJsonValue },
  })
  statsCache.clear()
  successionCache.clear()
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

type BpRow = { caseId: string; systolic: number | null; diastolic: number | null; month: Date | null; n: number }
type HrRow = { caseId: string; heartRate: number; month: Date | null; n: number }

/** The band of every case in scope that has started, from the patient's age. */
async function caseBands(db: Db, scope: Prisma.CaseWhereInput): Promise<Map<string, VitalBandKey>> {
  const cases = await db.case.findMany({
    where: { AND: [scope, { intraop: { startedAt: { not: null } } }] },
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
  const notCopied = Prisma.sql`COALESCE(("metadataJson"->>'autoFilled')::boolean, false) = false`
  const bp = await db.$queryRaw<BpRow[]>`
    SELECT "caseId", systolic, diastolic, ${month} AS month, COUNT(*)::int AS n
    FROM "CaseEvent"
    WHERE type = 'vital' AND status = 'active' AND "caseId" = ANY(${caseIds})
      AND (systolic IS NOT NULL OR diastolic IS NOT NULL) AND ${notCopied}
    GROUP BY 1, 2, 3, 4`
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
    if (row.systolic != null) add(counts, band, "sbp", row.systolic, row.n, row.caseId)
    if (row.diastolic != null) add(counts, band, "dbp", row.diastolic, row.n, row.caseId)
    if (row.systolic != null && row.diastolic != null) add(counts, band, "map", meanArterialPressure(row.systolic, row.diastolic), row.n, row.caseId)
  }
  for (const row of rows.hr) {
    const band = bands.get(row.caseId)
    if (band) add(counts, band, "hr", row.heartRate, row.n, row.caseId)
  }
}

const STATS_TTL_MS = 10 * 60_000
const statsCache = new Map<string, { at: number; stats: VitalStatsTable }>()

/** Every band's reading counts in scope, all time. Kept ten minutes: limits move slowly. */
export async function vitalStats(db: Db, scope: Prisma.CaseWhereInput, now = Date.now()): Promise<VitalStatsTable> {
  const key = JSON.stringify(scope)
  const cached = statsCache.get(key)
  if (cached && now - cached.at < STATS_TTL_MS) return cached.stats
  const bands = await caseBands(db, scope)
  const counts: BandCounts = new Map()
  countRows(counts, bands, await readingRows(db, [...bands.keys()], false))
  const stats = toTable(counts)
  statsCache.set(key, { at: now, stats })
  return stats
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
  const bands = await caseBands(db, scope)
  const rows = await readingRows(db, [...bands.keys()], true)
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
  const cases = await db.case.findMany({
    where: { AND: [scope, { status: "COMPLETE" }, { intraop: { startedAt: { not: null } } }] },
    select: { id: true, clinicalMode: true, intraop: { select: { techniques: true } } },
    orderBy: { createdAt: "desc" },
    take: SUCCESSION_CASES_MAX,
  })
  const byCase = new Map<string, SuccessionCase>()
  for (const item of cases) {
    const techniques = Array.isArray(item.intraop?.techniques) ? (item.intraop!.techniques as unknown[]).filter((value): value is string => typeof value === "string") : []
    byCase.set(item.id, { context: successionContext(techniques, item.clinicalMode === "PEDIATRIC"), events: [] })
  }
  const ids = [...byCase.keys()]
  const events = [...SEQUENCE_EVENTS]
  for (let offset = 0; offset < ids.length; offset += SUCCESSION_BATCH) {
    const rows = await db.caseEvent.findMany({
      where: { caseId: { in: ids.slice(offset, offset + SUCCESSION_BATCH) }, status: "active", type: "clinical_event", label: { in: events } },
      select: { caseId: true, label: true, timestamp: true },
    })
    for (const row of rows) {
      if (row.label) (byCase.get(row.caseId)!.events as Array<{ label: string; ts: string }>).push({ label: row.label, ts: row.timestamp.toISOString() })
    }
  }
  const links = buildSuccessionStats([...byCase.values()])
  successionCache.set(key, { at: now, links })
  return links
}

/** The links the apps use: the starting values, with each starting event replaced once its cases have been seen often enough. */
export async function successionForClient(db: Db, scope: Prisma.CaseWhereInput): Promise<SuccessionLink[]> {
  return mergeSuccession(SEED_SUCCESSION, await learnedSuccession(db, scope))
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
const acceptanceCache = new Map<number, { at: number; value: SuggestionAcceptance }>()

export type SuggestionAcceptance = { days: number; cases: number; byId: SuggestionCounts }

export async function suggestionAcceptance(db: Db, days = 90, now = Date.now()): Promise<SuggestionAcceptance> {
  const cached = acceptanceCache.get(days)
  if (cached && now - cached.at < STATS_TTL_MS) return cached.value
  const since = new Date(now - days * 86_400_000)
  const cases = await db.case.findMany({
    where: { intraop: { startedAt: { gte: since } } },
    select: { id: true },
    take: ACCEPTANCE_CASES_MAX,
  })
  const byId: SuggestionCounts = {}
  for (let from = 0; from < cases.length; from += ACCEPTANCE_BATCH) {
    const ids = cases.slice(from, from + ACCEPTANCE_BATCH).map(item => item.id)
    const rows = await db.caseEvent.findMany({
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
  const value = { days, cases: cases.length, byId }
  acceptanceCache.set(days, { at: now, value })
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
