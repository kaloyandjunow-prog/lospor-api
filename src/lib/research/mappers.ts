import type {
  ResearchCaseDetail,
  ResearchCaseSummary,
  ResearchDistribution,
  ResearchDistributionId,
  ResearchMetric,
  ResearchMetricId,
} from "@lospor/core/research"
import {
  researchPercent,
  shouldSuppressResearchBinary,
  shouldSuppressResearchCell,
} from "@lospor/core/research"
import { formatCanonicalConcentration } from "@/lib/case-event-schema"
import type { Prisma } from "@/generated/prisma/client"

export const RESEARCH_SUMMARY_SELECT = {
  id: true,
  caseCode: true,
  status: true,
  clinicalMode: true,
  clinicalRulesVersion: true,
  finalizedAt: true,
  preop: {
    select: {
      ageYears: true,
      ageValue: true,
      ageUnit: true,
      ageApproxDays: true,
      sex: true,
      asaScore: true,
      diagnoses: {
        select: { code: true, sourceCode: true, label: true, labelEn: true, labelBg: true },
        orderBy: { ordinal: "asc" },
        take: 1,
      },
      procedureRows: {
        select: { code: true, sourceCode: true, description: true, group: true },
        orderBy: { ordinal: "asc" },
        take: 1,
      },
    },
  },
  intraop: {
    select: {
      monthYear: true,
      durationMinutes: true,
    },
  },
  postop: { select: { disposition: true } },
  selections: {
    where: { category: "technique" },
    select: { value: true },
    orderBy: { ordinal: "asc" },
  },
  fieldStatuses: {
    select: { presence: true },
  },
  _count: { select: { complications: true } },
} satisfies Prisma.CaseSelect

export type ResearchSummaryRow = Prisma.CaseGetPayload<{
  select: typeof RESEARCH_SUMMARY_SELECT
}>

export const RESEARCH_DETAIL_SELECT = {
  ...RESEARCH_SUMMARY_SELECT,
  snapshot: { select: { finalizedAt: true } },
  preop: {
    select: {
      ageYears: true,
      sex: true,
      ageValue: true,
      ageUnit: true,
      ageApproxDays: true,
      bodySurfaceAreaM2: true,
      heightCm: true,
      weightKg: true,
      bmi: true,
      asaScore: true,
      emergencySurgery: true,
      highRiskSurgery: true,
      smoking: true,
      difficultAirwayHistory: true,
      mallampati: true,
      rcriScore: true,
      apfelScore: true,
      stopBangScore: true,
      povocScore: true,
      povocRiskPercent: true,
      coldsApplicable: true,
      coldsScore: true,
      diagnoses: {
        select: {
          code: true,
          sourceCode: true,
          label: true,
          labelEn: true,
          labelBg: true,
          mappingStatus: true,
        },
        orderBy: { ordinal: "asc" },
      },
      comorbidityRows: {
        select: {
          code: true,
          icd10Code: true,
          sourceCode: true,
          label: true,
          labelEn: true,
          labelBg: true,
          mappingStatus: true,
        },
        orderBy: { ordinal: "asc" },
      },
      procedureRows: {
        select: {
          code: true,
          sourceCode: true,
          description: true,
          group: true,
          mappingStatus: true,
        },
        orderBy: { ordinal: "asc" },
      },
      medications: {
        select: {
          atcCode: true,
          inn: true,
          mappingStatus: true,
        },
        orderBy: { ordinal: "asc" },
      },
      labRows: {
        select: {
          loincCode: true,
          test: true,
          valueNum: true,
          value: true,
          unitCanon: true,
          abnormalFlag: true,
          mappingStatus: true,
        },
        orderBy: { ordinal: "asc" },
      },
    },
  },
  intraop: {
    select: {
      monthYear: true,
      durationMinutes: true,
      startedAt: true,
      endedAt: true,
      timezone: true,
      airwayDevice: true,
      crystalloidsMl: true,
      colloidsMl: true,
      bloodMl: true,
      urineMl: true,
    },
  },
  postop: {
    select: {
      aldreteTotal: true,
      painScoreNRS: true,
      ponv: true,
      disposition: true,
      recoveryBpSystolic: true,
      pediatricPainScale: true,
      pediatricPainScore: true,
      paedScore: true,
      recoveryBpDiastolic: true,
      recoveryHeartRate: true,
      recoverySpO2: true,
      temperatureCelsius: true,
    },
  },
  selections: {
    select: { category: true, value: true },
    orderBy: [{ category: "asc" }, { ordinal: "asc" }],
  },
  complications: {
    select: {
      section: true,
      sourceCode: true,
      label: true,
      timestamp: true,
      mappingStatus: true,
    },
    orderBy: { ordinal: "asc" },
  },
  events: {
    where: { status: "active" },
    select: {
      id: true,
      type: true,
      timestamp: true,
      unit: true,
      systolic: true,
      diastolic: true,
      heartRate: true,
      spO2: true,
      etco2: true,
      temp: true,
      bgl: true,
      fgfLitersPerMin: true,
      carrierGas: true,
      fio2Percent: true,
      fiAirPercent: true,
      fiN2OPercent: true,
      atcCode: true,
      inn: true,
      drugRoute: true,
      rate: true,
      concentration: true,
      concentrationValue: true,
      concentrationUnit: true,
      formulation: true,
      calculationBasis: true,
      calculationWeightKg: true,
      calculationMethod: true,
      clinicalRuleKey: true,
      clinicalRuleVersion: true,
      clinicalRuleSourceIds: true,
      clinicalPresetId: true,
      clinicalPresetVersion: true,
      clinicalPresetScope: true,
      volume: true,
      fluidCategory: true,
      agentPercent: true,
      clinicalEventCode: true,
    },
    orderBy: { timestamp: "asc" },
  },
} satisfies Prisma.CaseSelect

export type ResearchDetailRow = Prisma.CaseGetPayload<{
  select: typeof RESEARCH_DETAIL_SELECT
}>

export function completeness(
  statuses: Array<{ presence: string }>,
): number {
  if (!statuses.length) return 0
  const complete = statuses.filter(status =>
    status.presence === "PRESENT" || status.presence === "NOT_APPLICABLE").length
  return Math.round((complete / statuses.length) * 1000) / 10
}

function researchId(row: { id: string; caseCode: string | null }): string {
  return row.caseCode ?? `R-${row.id.slice(-8).toUpperCase()}`
}

export function mapResearchSummary(row: ResearchSummaryRow): ResearchCaseSummary {
  const diagnosis = row.preop?.diagnoses[0]
  const procedure = row.preop?.procedureRows[0]
  return {
    id: row.id,
    researchId: researchId(row),
    status: row.status,
    period: row.intraop?.monthYear ?? row.finalizedAt?.toISOString().slice(0, 7) ?? null,
    ageYears: row.preop?.ageYears ?? null,
    sex: row.preop?.sex ?? null,
    asa: row.preop?.asaScore ?? null,
    clinicalMode: row.clinicalMode,
    clinicalRulesVersion: row.clinicalRulesVersion,
    ageValue: row.preop?.ageValue ?? null,
    ageUnit: row.preop?.ageUnit ?? null,
    ageApproxDays: row.preop?.ageApproxDays ?? null,
    diagnosis: diagnosis?.labelEn ?? diagnosis?.label ?? null,
    diagnosisCode: diagnosis?.code ?? diagnosis?.sourceCode ?? null,
    diagnosisLabelEn: diagnosis?.labelEn ?? diagnosis?.label ?? null,
    diagnosisLabelBg: diagnosis?.labelBg ?? null,
    procedure: procedure?.group ?? procedure?.description ?? null,
    procedureCode: procedure?.code ?? procedure?.sourceCode ?? null,
    procedureLabelEn: procedure?.group ?? procedure?.description ?? null,
    procedureLabelBg: null,
    durationMinutes: row.intraop?.durationMinutes ?? null,
    technique: row.selections.map(selection => selection.value),
    disposition: row.postop?.disposition ?? null,
    complications: row._count.complications,
    completeness: completeness(row.fieldStatuses),
  }
}

function eventLabel(event: ResearchDetailRow["events"][number]): {
  label: string
  value?: string | number | null
  unit?: string | null
} {
  if (event.type === "vital") {
    const values = [
      event.systolic != null && event.diastolic != null
        ? `BP ${event.systolic}/${event.diastolic}`
        : null,
      event.heartRate != null ? `HR ${event.heartRate}` : null,
      event.spO2 != null ? `SpO2 ${event.spO2}%` : null,
      event.etco2 != null ? `EtCO2 ${event.etco2}` : null,
      event.temp != null ? `Temp ${event.temp} C` : null,
      event.bgl != null ? `Glucose ${event.bgl}` : null,
    ].filter(Boolean)
    return { label: "Vitals", value: values.join(" | ") }
  }
  if (event.type === "gas_start" || event.type === "gas_change") {
    const mix = event.carrierGas === "air"
      ? `O2/Air ${event.fio2Percent ?? 0}/${event.fiAirPercent ?? 0}`
      : event.carrierGas === "n2o"
        ? `O2/N2O ${event.fio2Percent ?? 0}/${event.fiN2OPercent ?? 0}`
        : `O2 ${event.fio2Percent ?? 100}%`
    return {
      label: event.type === "gas_start" ? "Fresh gas started" : "Fresh gas changed",
      value: `FGF ${event.fgfLitersPerMin ?? 0} L/min | ${mix}`,
    }
  }
  if (event.type === "drug") {
    const concentration = event.concentration
      ?? formatCanonicalConcentration(event.concentrationValue, event.concentrationUnit)
    const audit = [
      concentration,
      event.formulation,
      event.calculationBasis && event.calculationMethod
        ? `${event.calculationBasis}:${event.calculationMethod}`
        : event.calculationBasis ?? event.calculationMethod,
      event.clinicalRuleKey && event.clinicalRuleVersion
        ? `${event.clinicalRuleKey}@${event.clinicalRuleVersion}`
        : event.clinicalRuleKey ?? event.clinicalRuleVersion,
      event.clinicalPresetId && event.clinicalPresetVersion
        ? `${event.clinicalPresetScope ?? "PRESET"}:${event.clinicalPresetId}@${event.clinicalPresetVersion}`
        : event.clinicalPresetId,
    ].filter((value): value is string => !!value)
    return {
      label: event.inn ?? event.atcCode ?? "Medication",
      value: audit.length ? audit.join(" | ") : null,
      unit: event.unit,
    }
  }
  if (event.type.startsWith("infusion")) {
    return {
      label: event.inn ?? event.atcCode ?? "Infusion",
      value: event.rate,
      unit: event.unit,
    }
  }
  if (event.type.startsWith("fluid")) {
    return {
      label: event.fluidCategory ?? "Fluid",
      value: event.volume,
      unit: event.unit ?? "mL",
    }
  }
  if (event.type.startsWith("agent")) {
    return {
      label: event.clinicalEventCode ?? "Volatile agent",
      value: event.agentPercent,
      unit: "%",
    }
  }
  return {
    label: event.clinicalEventCode ?? event.type.replaceAll("_", " "),
  }
}

export function mapResearchDetail(row: ResearchDetailRow): ResearchCaseDetail {
  const summary = mapResearchSummary(row)
  const startedAt = row.intraop?.startedAt?.getTime()
  const selections = (category: string) =>
    row.selections.filter(item => item.category === category).map(item => item.value)
  const warnings: string[] = []
  if (!row.snapshot) warnings.push("MISSING_FINALIZATION_SNAPSHOT")
  if (!row.intraop?.startedAt || !row.intraop?.endedAt) warnings.push("MISSING_INTRAOP_TIMES")
  if (
    row.intraop?.startedAt &&
    row.intraop?.endedAt &&
    row.intraop.endedAt < row.intraop.startedAt
  ) warnings.push("IMPOSSIBLE_INTRAOP_TIMELINE")

  return {
    ...summary,
    demographics: {
      ageYears: row.preop?.ageYears ?? null,
      sex: row.preop?.sex ?? null,
      heightCm: row.preop?.heightCm ?? null,
      weightKg: row.preop?.weightKg ?? null,
      bmi: row.preop?.bmi ?? null,
      clinicalMode: row.clinicalMode,
      clinicalRulesVersion: row.clinicalRulesVersion,
      ageValue: row.preop?.ageValue ?? null,
      ageUnit: row.preop?.ageUnit ?? null,
      ageApproxDays: row.preop?.ageApproxDays ?? null,
      bodySurfaceAreaM2: row.preop?.bodySurfaceAreaM2 ?? null,
      asa: row.preop?.asaScore ?? null,
      emergency: row.preop?.emergencySurgery ?? false,
      highRisk: row.preop?.highRiskSurgery ?? false,
      smoking: row.preop?.smoking ?? false,
      difficultAirwayHistory: row.preop?.difficultAirwayHistory ?? false,
      mallampati: row.preop?.mallampati ?? null,
      rcri: row.preop?.rcriScore ?? null,
      apfel: row.preop?.apfelScore ?? null,
      stopBang: row.preop?.stopBangScore ?? null,
    },
    diagnoses: (row.preop?.diagnoses ?? []).map(item => ({
      code: item.code ?? item.sourceCode,
      label: item.labelEn ?? item.label,
      labelEn: item.labelEn ?? item.label,
      labelBg: item.labelBg,
      povoc: row.preop?.povocScore ?? null,
      povocRiskPercent: row.preop?.povocRiskPercent ?? null,
      coldsApplicable: row.preop?.coldsApplicable ?? false,
      colds: row.preop?.coldsScore ?? null,
      mappingStatus: item.mappingStatus,
    })),
    comorbidities: (row.preop?.comorbidityRows ?? []).map(item => ({
      code: item.icd10Code ?? item.code ?? item.sourceCode,
      label: item.labelEn ?? item.label,
      labelEn: item.labelEn ?? item.label,
      labelBg: item.labelBg,
      mappingStatus: item.mappingStatus,
    })),
    procedures: (row.preop?.procedureRows ?? []).map(item => ({
      code: item.code ?? item.sourceCode,
      label: item.group ?? item.description ?? item.code ?? "Procedure",
      labelEn: item.group ?? item.description ?? item.code ?? "Procedure",
      labelBg: null,
      group: item.group,
      mappingStatus: item.mappingStatus,
    })),
    medications: (row.preop?.medications ?? []).map(item => ({
      code: item.atcCode,
      label: item.inn ?? item.atcCode ?? "Medication",
      labelEn: item.inn ?? item.atcCode ?? "Medication",
      labelBg: null,
      mappingStatus: item.mappingStatus,
    })),
    labs: (row.preop?.labRows ?? []).map(item => ({
      code: item.loincCode,
      label: item.test,
      labelEn: item.test,
      labelBg: null,
      value: item.valueNum ?? item.value,
      unit: item.unitCanon,
      flag: item.abnormalFlag,
      mappingStatus: item.mappingStatus,
    })),
    intraoperative: {
      durationMinutes: row.intraop?.durationMinutes ?? null,
      techniques: selections("technique"),
      positions: selections("position"),
      monitoring: selections("monitoring"),
      airwayDevice: row.intraop?.airwayDevice ?? null,
      crystalloidsMl: row.intraop?.crystalloidsMl ?? null,
      colloidsMl: row.intraop?.colloidsMl ?? null,
      bloodMl: row.intraop?.bloodMl ?? null,
      urineMl: row.intraop?.urineMl ?? null,
    },
    postoperative: {
      aldreteTotal: row.postop?.aldreteTotal ?? null,
      painScore: row.postop?.painScoreNRS ?? null,
      ponv: row.postop?.ponv ?? false,
      disposition: row.postop?.disposition ?? null,
      recoveryBpSystolic: row.postop?.recoveryBpSystolic ?? null,
      recoveryBpDiastolic: row.postop?.recoveryBpDiastolic ?? null,
      recoveryHeartRate: row.postop?.recoveryHeartRate ?? null,
      recoverySpO2: row.postop?.recoverySpO2 ?? null,
      temperatureCelsius: row.postop?.temperatureCelsius ?? null,
      pediatricPainScale: row.postop?.pediatricPainScale ?? null,
      pediatricPainScore: row.postop?.pediatricPainScore ?? null,
      paedScore: row.postop?.paedScore ?? null,
      handover: selections("handoverItem"),
    },
    timeline: row.events.map(event => ({
      id: event.id,
      minute: startedAt === undefined
        ? null
        : Math.round((event.timestamp.getTime() - startedAt) / 60_000),
      type: event.type,
      code: event.clinicalEventCode ?? event.type,
      ...eventLabel(event),
      labelEn: eventLabel(event).label,
      labelBg: null,
    })),
    quality: {
      snapshotPresent: !!row.snapshot,
      finalized: row.status === "COMPLETE",
      fieldCompleteness: completeness(row.fieldStatuses),
      warnings,
    },
  }
}

export function metric(
  id: ResearchMetricId,
  value: number | null,
  denominator: number,
  options: {
    numerator?: number
    unit?: ResearchMetric["unit"]
    binary?: boolean
    hideExact?: boolean
  } = {},
): ResearchMetric {
  const suppressed = options.binary && options.numerator !== undefined
    ? shouldSuppressResearchBinary(options.numerator, denominator)
    : shouldSuppressResearchCell(denominator)
  const hidden = suppressed || options.hideExact === true
  return {
    id,
    value: hidden ? null : value,
    ...(options.numerator !== undefined
      ? { numerator: hidden ? null : options.numerator }
      : {}),
    denominator: hidden ? null : denominator,
    ...(options.unit ? { unit: options.unit } : {}),
    suppressed,
  }
}

export function distribution(
  id: ResearchDistributionId,
  counts: Map<string, {
    label: string
    labelEn?: string
    labelBg?: string | null
    cases: Set<string>
  }>,
): ResearchDistribution {
  const entries = [...counts.entries()]
  const validCases = new Set(entries.flatMap(([, item]) => [...item.cases]))
  const primarySuppressed = new Set(
    entries
      .filter(([, item]) => shouldSuppressResearchCell(item.cases.size))
      .map(([key]) => key),
  )
  if (primarySuppressed.size > 0) {
    const secondary = entries
      .filter(([key, item]) => !primarySuppressed.has(key) && item.cases.size > 0)
      .sort((left, right) => left[1].cases.size - right[1].cases.size)[0]
    if (secondary) primarySuppressed.add(secondary[0])
  }
  return {
    id,
    buckets: entries
      .map(([key, item]) => {
        const count = item.cases.size
        const suppressed = primarySuppressed.has(key)
        return {
          key,
          label: item.label,
          labelEn: item.labelEn ?? item.label,
          labelBg: item.labelBg ?? null,
          count: suppressed ? null : count,
          percent: suppressed ? null : researchPercent(count, validCases.size),
          suppressed,
        }
      })
      .sort((a, b) => (b.count ?? -1) - (a.count ?? -1))
      .slice(0, 25),
  }
}
