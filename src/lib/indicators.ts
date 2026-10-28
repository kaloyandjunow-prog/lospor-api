import type { Prisma, PrismaClient } from "@/generated/prisma/client"
import type { AuthUser } from "@/lib/access-control"
import { activeCaseLog } from "@/lib/case-events"
import { evaluateCaseReadiness } from "@/lib/case-finalization"
import { projectIntraopEvents } from "@lospor/core/intraop-engine"
import { parseLogEvents } from "@lospor/core/intraop-types"
import { caseTheatreName } from "@lospor/core/operating-theatres"
import { blockerKinds } from "@lospor/core/case-readiness"
import { procedureGroupOf } from "@lospor/core/procedure-codes"
import {
  aggregateIndicators,
  CASE_SUMMARY_VERSION,
  DEFAULT_INDICATOR_CONFIG,
  indicatorConfigKey,
  parseIndicatorConfig,
  summarizeCaseIndicators,
  type CaseIndicatorSummary,
  type IndicatorConfig,
  type IndicatorRow,
  type IndicatorsReport,
} from "@lospor/core/indicators"

/**
 * The unit indicators (10.0.0): aggregate figures over a department's cases,
 * open to every user in it. Each case's figures are worked out once and kept
 * (CaseIndicatorSummary) until the case or the thresholds change; a report
 * brings stale ones up to date, a batch at a time, then aggregates.
 *
 * Operational, not research: computed from the live record, never exported,
 * and no figure rests on fewer than five cases.
 */

type Db = PrismaClient | Prisma.TransactionClient

const POLICY_ID = "local"
/** Cases worked out per request; the rest follow on the next. */
export const REFRESH_BATCH = 200
/** The widest period one report covers. */
export const MAX_PERIOD_DAYS = 366

export async function readIndicatorConfig(db: Db): Promise<IndicatorConfig> {
  const row = await db.indicatorPolicy.findUnique({ where: { id: POLICY_ID } })
  return row ? parseIndicatorConfig(row.config) : DEFAULT_INDICATOR_CONFIG
}

/** Saves the thresholds and the names switch; values out of range fall back to the defaults. */
export async function saveIndicatorConfig(db: Db, value: unknown): Promise<IndicatorConfig> {
  const config = parseIndicatorConfig(value)
  await db.indicatorPolicy.upsert({
    where: { id: POLICY_ID },
    create: { id: POLICY_ID, config: config as unknown as Prisma.InputJsonValue },
    update: { config: config as unknown as Prisma.InputJsonValue },
  })
  return config
}

/** The cases a user's ward figures cover: their department, or their own cases without one. */
export function indicatorScope(user: Pick<AuthUser, "id" | "institutionId">): Prisma.CaseWhereInput {
  return user.institutionId ? { institutionId: user.institutionId } : { userId: user.id }
}

function ageInDays(preop: { ageValue: number | null; ageUnit: string | null; ageYears: number | null; ageApproxDays: number | null } | null): number | null {
  if (!preop) return null
  if (preop.ageApproxDays != null) return preop.ageApproxDays
  if (preop.ageValue != null && preop.ageUnit) {
    return preop.ageUnit === "DAYS" ? preop.ageValue : preop.ageUnit === "MONTHS" ? Math.round(preop.ageValue * 30.44) : Math.round(preop.ageValue * 365.25)
  }
  return preop.ageYears != null ? Math.round(preop.ageYears * 365.25 + 182) : null
}

/**
 * The procedure a case is grouped under: the first procedure done when it is
 * recorded (10.0.0), else the first planned; its group, as the apps show it,
 * not the exact operation that may follow it. A plan not yet known has no
 * group until the procedure done names one.
 */
export function procedureGroup(
  preop: { plannedProcedure: string | null; proceduresJson: unknown } | null,
  performedProceduresJson?: unknown,
): string | null {
  const firstOf = (list: unknown) => Array.isArray(list) ? list[0] as Record<string, unknown> | undefined : undefined
  for (const first of [firstOf(performedProceduresJson), firstOf(preop?.proceduresJson)]) {
    if (!first || typeof first !== "object") continue
    const group = procedureGroupOf(first) ?? (typeof first.label === "string" ? first.label.trim() : "")
    if (group) return group
  }
  return preop?.plannedProcedure?.split(";")[0]?.split(":")[0]?.trim() || null
}

/** Works out one case's figures from its record. Null for a case whose intraop has not started. */
export async function computeCaseSummary(db: Db, caseId: string, config: IndicatorConfig): Promise<CaseIndicatorSummary | null> {
  const record = await db.case.findUnique({
    where: { id: caseId },
    select: {
      status: true, clinicalMode: true, finalizedAt: true,
      preop: { select: { ageValue: true, ageUnit: true, ageYears: true, ageApproxDays: true, sex: true, weightKg: true, heightCm: true, asaScore: true, apfelScore: true, plannedProcedure: true, proceduresJson: true } },
      intraop: { select: { startedAt: true, endedAt: true, timezone: true, autoEndedAt: true, techniques: true, airwayDevice: true, airwayTools: true, cormackLehane: true } },
      postop: { select: { painScoreNRS: true, flaccTotal: true, nipsTotal: true, fpsrScore: true, ponv: true, paedScore: true, aldreteTotal: true, stewardTotal: true, temperatureCelsius: true, disposition: true, performedProceduresJson: true } },
      complications: { select: { label: true } },
    },
  })
  const startedAt = record?.intraop?.startedAt
  if (!record || !startedAt) return null
  const endedAt = record.intraop!.endedAt
  const timetable = projectIntraopEvents(parseLogEvents(await activeCaseLog(db, caseId)), {
    start: startedAt,
    endedAt,
    openThrough: new Date(),
  })
  const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
  const missing = record.status === "COMPLETE"
    ? []
    : blockerKinds((await evaluateCaseReadiness(db, caseId, record.clinicalMode)).issues)
  const preop = record.preop
  const postop = record.postop
  return summarizeCaseIndicators({
    status: record.status,
    clinicalMode: record.clinicalMode,
    startedAt,
    endedAt,
    timezone: record.intraop!.timezone,
    finalizedAt: record.finalizedAt,
    autoEndedAt: record.intraop!.autoEndedAt,
    ageDays: ageInDays(preop),
    sex: preop?.sex ?? null,
    weightKg: preop?.weightKg ?? null,
    heightCm: preop?.heightCm ?? null,
    asa: preop?.asaScore ?? null,
    apfel: preop?.apfelScore ?? null,
    procedure: procedureGroup(preop, postop?.performedProceduresJson),
    techniques: strings(record.intraop!.techniques),
    airwayDevice: record.intraop!.airwayDevice,
    airwayTools: strings(record.intraop!.airwayTools),
    cormackLehane: record.intraop!.cormackLehane,
    complications: record.complications.map(item => item.label),
    postop: postop ? {
      painNRS: postop.painScoreNRS, flaccTotal: postop.flaccTotal, nipsTotal: postop.nipsTotal, fpsrScore: postop.fpsrScore,
      ponv: postop.ponv, paedScore: postop.paedScore, aldreteTotal: postop.aldreteTotal, stewardTotal: postop.stewardTotal,
      temperature: postop.temperatureCelsius, disposition: postop.disposition,
    } : null,
    timetable,
    missing,
  }, config)
}

/**
 * Brings the figures of the started cases in scope up to date, oldest change
 * first, at most `limit` of them. Returns how many are still waiting.
 */
export async function refreshCaseSummaries(db: PrismaClient, where: Prisma.CaseWhereInput, config: IndicatorConfig, limit = REFRESH_BATCH): Promise<{ refreshed: number; pending: number }> {
  const key = indicatorConfigKey(config)
  const cases = await db.case.findMany({
    where: { AND: [where, { intraop: { startedAt: { not: null } } }] },
    select: {
      id: true, institutionId: true, clinicalRevision: true, eventRevision: true, relationalRevision: true,
      intraop: { select: { startedAt: true } },
      indicatorSummary: { select: { clinicalRevision: true, eventRevision: true, relationalRevision: true, configKey: true, version: true } },
    },
  })
  const stale = cases.filter(item => {
    const summary = item.indicatorSummary
    return !summary || summary.version !== CASE_SUMMARY_VERSION || summary.configKey !== key
      || summary.clinicalRevision !== item.clinicalRevision || summary.eventRevision !== item.eventRevision
      || summary.relationalRevision !== item.relationalRevision
  })
  const batch = stale.slice(0, limit)
  for (const item of batch) {
    const summary = await computeCaseSummary(db, item.id, config)
    if (!summary) continue
    const data = {
      institutionId: item.institutionId,
      startedAt: item.intraop!.startedAt!,
      clinicalRevision: item.clinicalRevision,
      eventRevision: item.eventRevision,
      relationalRevision: item.relationalRevision,
      configKey: key,
      version: CASE_SUMMARY_VERSION,
      payload: summary as unknown as Prisma.InputJsonValue,
      computedAt: new Date(),
    }
    await db.caseIndicatorSummary.upsert({ where: { caseId: item.id }, create: { caseId: item.id, ...data }, update: data })
  }
  return { refreshed: batch.length, pending: stale.length - batch.length }
}

export type IndicatorFilters = {
  from: Date
  to: Date
  theatreId?: string | null
  assigneeId?: string | null
  mode?: "ADULT" | "PEDIATRIC" | null
  procedure?: string | null
  asa?: string | null
}

export type IndicatorsResponse = {
  period: { from: string; to: string }
  pending: number
  config: IndicatorConfig
  filters: { theatres: { id: string; name: string }[]; anaesthesiologists: { id: string; name: string }[]; procedures: string[] }
  report: IndicatorsReport
}

/**
 * The ward report for a user: their department's started cases in the period,
 * filtered. With colleagues' names off, the anaesthesiologist filter takes
 * only the user themself: choosing a named colleague would show that
 * colleague's figures by name.
 *
 * The filters' own choices come from the whole period, not the filtered rows:
 * with theatre A chosen, theatre B must still be offered.
 */
export async function wardIndicators(db: PrismaClient, user: Pick<AuthUser, "id" | "institutionId">, filters: IndicatorFilters): Promise<IndicatorsResponse> {
  const config = await readIndicatorConfig(db)
  const scope = indicatorScope(user)
  // Only the period's cases are brought up to date: a report never reads the rest.
  const { pending } = await refreshCaseSummaries(db, { AND: [scope, { intraop: { startedAt: { gte: filters.from, lt: filters.to } } }] }, config)
  const assigneeId = filters.assigneeId && (config.namedClinicians || filters.assigneeId === user.id) ? filters.assigneeId : null
  const rows = await db.caseIndicatorSummary.findMany({
    where: { startedAt: { gte: filters.from, lt: filters.to }, case: scope },
    select: {
      caseId: true,
      payload: true,
      case: { select: { userId: true, operatingTheatreId: true, operatingTheatreName: true, operatingTheatre: { select: { name: true } } } },
    },
  })
  const all: IndicatorRow[] = rows.map(row => ({
    ...(row.payload as unknown as CaseIndicatorSummary),
    caseId: row.caseId,
    theatreId: row.case.operatingTheatreId,
    theatreName: caseTheatreName(row.case),
    assigneeId: row.case.userId,
  }))
  const procedures = [...new Set(all.map(row => row.procedure).filter((value): value is string => !!value))].sort()
  const theatreWanted = filters.theatreId === "none" ? null : filters.theatreId
  const filtered = all.filter(row => (!filters.theatreId || row.theatreId === theatreWanted)
    && (!assigneeId || row.assigneeId === assigneeId)
    && (!filters.mode || row.mode === filters.mode)
    && (!filters.procedure || row.procedure === filters.procedure)
    && (!filters.asa || row.asa === filters.asa))

  // Procedures cancelled in the period (10.0.0), under the same filters.
  const cancelled = await db.case.findMany({
    where: {
      AND: [scope, {
        status: "CANCELLED",
        cancelledAt: { gte: filters.from, lt: filters.to },
        ...(filters.theatreId ? { operatingTheatreId: filters.theatreId === "none" ? null : filters.theatreId } : {}),
        ...(assigneeId ? { userId: assigneeId } : {}),
        ...(filters.mode ? { clinicalMode: filters.mode } : {}),
        ...(filters.asa ? { preop: { is: { asaScore: filters.asa as never } } } : {}),
      }],
    },
    select: { cancellationReason: true, preop: { select: { plannedProcedure: true, proceduresJson: true } } },
  })
  // The procedure filter applies to them as to the rest (a cancelled case has only its plan).
  const cancellations = cancelled
    .filter(item => !filters.procedure || procedureGroup(item.preop) === filters.procedure)
    .map(item => item.cancellationReason ?? "OTHER")

  const assignees = [...new Set(all.map(row => row.assigneeId))]
  const users = await db.user.findMany({ where: { id: { in: assignees } }, select: { id: true, name: true } })
  const names = Object.fromEntries(users.map(item => [item.id, item.name]))
  const theatres = new Map<string, string>()
  for (const row of all) if (row.theatreId && row.theatreName) theatres.set(row.theatreId, row.theatreName)

  return {
    period: { from: filters.from.toISOString(), to: filters.to.toISOString() },
    pending,
    config,
    filters: {
      theatres: [...theatres.entries()].map(([id, name]) => ({ id, name })).sort((left, right) => left.name.localeCompare(right.name)),
      anaesthesiologists: (config.namedClinicians ? users : users.filter(item => item.id === user.id)).map(item => ({ id: item.id, name: item.name })),
      procedures,
    },
    report: aggregateIndicators(filtered, { config, viewerId: user.id, names, cancellations }),
  }
}
