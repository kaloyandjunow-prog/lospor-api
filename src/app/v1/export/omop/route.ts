import { NextRequest, NextResponse } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { requireRole } from "@/lib/access-control"
import { prisma } from "@/lib/prisma"
import { CaseStatus, Prisma } from "@/generated/prisma/client"
import { mapCasesToOmop } from "@/lib/omop-mapper"
import { redactText, deepRedactPII } from "@/lib/pii-check"

const VALID_STATUSES = new Set<string>(Object.values(CaseStatus))

type ExportRow = Prisma.CaseGetPayload<{ select: typeof CASE_SELECT }>

// Redacts the free-text fields this export actually selects — scalar String
// fields a clinician can type into directly, plus the freeform keyEvents
// JSON blob and each CaseEvent's label/value. Coded fields (comorbidities,
// diagnosesJson, proceduresJson, labRows) are left untouched: they're
// structured vocabulary entries, and blanket-redacting them would corrupt
// legitimate two-word diagnosis/institution labels via the name-pattern check.
function redactExportRow(c: ExportRow) {
  return {
    ...c,
    preop: c.preop ? {
      ...c.preop,
      diagnosis: c.preop.diagnosis ? redactText(c.preop.diagnosis) : c.preop.diagnosis,
      plannedProcedure: c.preop.plannedProcedure ? redactText(c.preop.plannedProcedure) : c.preop.plannedProcedure,
      allergyDetails: c.preop.allergyDetails ? redactText(c.preop.allergyDetails) : c.preop.allergyDetails,
      currentMedications: c.preop.currentMedications ? redactText(c.preop.currentMedications) : c.preop.currentMedications,
      medications: c.preop.medications.map(row => ({
        ...row,
        nameRaw: row.nameRaw ? redactText(row.nameRaw) : row.nameRaw,
      })),
    } : c.preop,
    events: (c.events ?? []).map(e => ({
      ...e,
      label: e.label ? redactText(e.label) : e.label,
      value: e.value ? redactText(e.value) : e.value,
    })),
    complications: (c.complications ?? []).map(comp => ({
      ...comp,
      note: comp.note ? redactText(comp.note) : comp.note,
    })),
    intraop: c.intraop ? {
      ...c.intraop,
      complications: c.intraop.complications ? redactText(c.intraop.complications) : c.intraop.complications,
      premedicationEvening: c.intraop.premedicationEvening ? redactText(c.intraop.premedicationEvening) : c.intraop.premedicationEvening,
      premedicationMorning: c.intraop.premedicationMorning ? redactText(c.intraop.premedicationMorning) : c.intraop.premedicationMorning,
      keyEvents: deepRedactPII(c.intraop.keyEvents),
      premedicationRows: c.intraop.premedicationRows.map(row => ({
        ...row,
        nameRaw: row.nameRaw ? redactText(row.nameRaw) : row.nameRaw,
      })),
    } : c.intraop,
  }
}

const CASE_SELECT = {
  id: true, caseCode: true, createdAt: true, status: true,
  institutionId: true,
  user: { select: { institution: { select: { name: true } } } },
  fieldStatuses: {
    select: { section: true, fieldKey: true, presence: true },
  },
  selections: {
    select: { section: true, category: true, value: true, ordinal: true },
    orderBy: [{ section: "asc" }, { category: "asc" }, { ordinal: "asc" }],
  },
  complications: {
    select: { section: true, label: true, note: true, timestamp: true, source: true, ordinal: true },
    orderBy: [{ section: "asc" }, { ordinal: "asc" }],
  },
  events: {
    where: { status: "active" },
    select: {
      type: true,
      timestamp: true,
      label: true,
      value: true,
      unit: true,
      systolic: true,
      diastolic: true,
      heartRate: true,
      spO2: true,
      etco2: true,
      temp: true,
      bgl: true,
      bglLoincCode: true,
      bglUnitCanon: true,
      fgfLitersPerMin: true,
      carrierGas: true,
      fio2Percent: true,
      fiAirPercent: true,
      fiN2OPercent: true,
      atcCode: true,
      drugId: true,
      inn: true,
      drugRoute: true,
      rate: true,
      concentration: true,
      volume: true,
      fluidCategory: true,
      agentPercent: true,
      clinicalEventCode: true,
      metadataJson: true,
    },
  },
  preop: {
    select: {
      ageYears: true, sex: true, heightCm: true, weightKg: true,
      bpSystolic: true, bpDiastolic: true, heartRate: true, spO2: true,
      temperature: true, respiratoryRate: true,
      diagnosis: true, diagnosesJson: true, plannedProcedure: true, proceduresJson: true,
      comorbidities: true, asaScore: true, emergencySurgery: true, highRiskSurgery: true,
      allergies: true, allergyDetails: true, smoking: true, substanceAbuse: true,
      currentMedications: true, rcriScore: true, apfelScore: true, stopBangScore: true,
      difficultAirwayHistory: true, mallampati: true, labResults: true,
      labRows: {
        select: {
          test: true, valueNum: true, value: true, unitCanon: true, loincCode: true, abnormalFlag: true,
          standardConceptId: true, mappingStatus: true,
        },
      },
      diagnoses: {
        select: {
          code: true, label: true, labelEn: true, labelBg: true,
          sourceVocabulary: true, sourceCode: true, standardConceptId: true, mappingStatus: true, ordinal: true,
        },
        orderBy: { ordinal: "asc" },
      },
      procedureRows: {
        select: {
          code: true, group: true, domain: true, description: true,
          sourceVocabulary: true, sourceCode: true, standardConceptId: true, mappingStatus: true, ordinal: true,
        },
        orderBy: { ordinal: "asc" },
      },
      comorbidityRows: {
        select: {
          label: true, labelEn: true, labelBg: true, code: true, icd10Code: true,
          sourceVocabulary: true, sourceCode: true, standardConceptId: true, mappingStatus: true, ordinal: true,
        },
        orderBy: { ordinal: "asc" },
      },
      medications: {
        select: {
          kind: true, nameRaw: true, inn: true, atcCode: true, dose: true, route: true,
          sourceVocabulary: true, sourceCode: true, standardConceptId: true, mappingStatus: true, ordinal: true,
        },
        orderBy: [{ kind: "asc" }, { ordinal: "asc" }],
      },
    },
  },
  intraop: {
    select: {
      startedAt: true, endedAt: true, timezone: true,
      startTime: true, endTime: true, durationMinutes: true, monthYear: true,
      techniques: true, keyEvents: true, airwayDevice: true,
      crystalloidsMl: true, colloidsMl: true, bloodMl: true, urineMl: true,
      complications: true, premedicationEvening: true, premedicationMorning: true,
      vascularAccessRows: {
        select: { site: true, siteLabel: true, size: true, sizeUnit: true, depthCm: true, lumens: true, preexisting: true, ordinal: true },
        orderBy: { ordinal: "asc" },
      },
      premedicationRows: {
        select: {
          phase: true, nameRaw: true, inn: true, atcCode: true, dose: true, route: true,
          sourceVocabulary: true, sourceCode: true, standardConceptId: true, mappingStatus: true, ordinal: true,
        },
        orderBy: [{ phase: "asc" }, { ordinal: "asc" }],
      },
    },
  },
  postop: {
    select: {
      aldreteActivity: true, aldreteRespiration: true, aldreteCirculation: true, aldreteConsciousness: true, aldreteSpO2: true,
      aldreteTotal: true, painScoreNRS: true, ponv: true, disposition: true,
      recoveryBpSystolic: true, recoveryBpDiastolic: true, recoveryHeartRate: true, recoverySpO2: true, temperatureCelsius: true,
      complications: true,
    },
  },
  snapshot:    { select: { id: true } },
  updatedAt:   true,
  finalizedAt: true,
} satisfies Prisma.CaseSelect

export async function GET(req: NextRequest) {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!requireRole(user, ["ADMIN"])) return NextResponse.json({ error: "Admin access required" }, { status: 403 })

  const caseId    = req.nextUrl.searchParams.get("caseId")
  const format    = req.nextUrl.searchParams.get("format") ?? "json"   // "json" | "csv"
  const rawStatus = req.nextUrl.searchParams.get("status")             // comma-separated status override
  const force     = req.nextUrl.searchParams.get("force") === "true"   // admin override for FAIL gate

  const allowedStatuses: CaseStatus[] = rawStatus
    ? rawStatus.split(",").map(s => s.trim().toUpperCase()).filter(s => VALID_STATUSES.has(s)) as CaseStatus[]
    : [CaseStatus.COMPLETE]

  const where: Prisma.CaseWhereInput = caseId
    ? { id: caseId }
    : { status: { in: allowedStatuses } }

  const [cases, excludedCount] = await Promise.all([
    prisma.case.findMany({
      where,
      select: CASE_SELECT,
      orderBy: { createdAt: "asc" },
      take: 5000,
    }),
    caseId ? Promise.resolve(0) : prisma.case.count({
      where: { status: { notIn: allowedStatuses } },
    }),
  ])

  if (caseId && cases.length === 0) {
    return NextResponse.json({ error: "Case not found" }, { status: 404 })
  }

  const bundle = mapCasesToOmop(cases.map(redactExportRow), {
    userId:            user.id,
    userRole:          user.role ?? "unknown",
    statusFilter:      caseId ? [] : allowedStatuses,
    excludedCaseCount: excludedCount,
    gitCommit:         process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? "untracked",
    forcedOverride:    force,
  })

  if (bundle.metadata.data_quality_status === "FAIL" && !force) {
    return NextResponse.json(
      {
        error:               "Export blocked: data quality gate FAIL",
        hint:                "Resolve the flagged issues or pass ?force=true to override as ADMIN",
        data_quality_status: "FAIL",
        quality_warnings:    bundle.metadata.quality_warnings.filter(w => w.severity === "error"),
      },
      { status: 422 },
    )
  }

  if (format === "csv") {
    const csv = bundleToCsv(bundle)
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="lospor_omop_${new Date().toISOString().substring(0,10)}.csv"`,
      },
    })
  }

  return NextResponse.json(bundle, {
    headers: {
      "Content-Disposition": `attachment; filename="lospor_omop_${new Date().toISOString().substring(0,10)}.json"`,
    },
  })
}

/** Flatten the OMOP bundle to a simple newline-delimited multi-table CSV */
function bundleToCsv(bundle: ReturnType<typeof mapCasesToOmop>): string {
  const sections: string[] = []
  const metadataRows = [
    ["export_id",               bundle.metadata.export_id],
    ["omop_cdm_version",        bundle.metadata.omop_cdm_version],
    ["generated_at",            bundle.metadata.generated_at],
    ["generated_by_role",       bundle.metadata.generated_by_role],
    ["source",                  bundle.metadata.source],
    ["source_version",          bundle.metadata.source_version],
    ["schema_version",          bundle.metadata.schema_version],
    ["concept_map_version",     bundle.metadata.concept_map_version],
    ["data_dictionary_version", bundle.metadata.data_dictionary_version],
    ["case_status_filter",      JSON.stringify(bundle.metadata.case_status_filter)],
    ["date_range",              JSON.stringify(bundle.metadata.date_range)],
    ["included_case_count",     String(bundle.metadata.included_case_count)],
    ["excluded_case_count",     String(bundle.metadata.excluded_case_count)],
    ["app_git_commit",          bundle.metadata.app_git_commit],
    ["forced_override",         String(bundle.metadata.forced_override)],
    ["data_quality_status",     bundle.metadata.data_quality_status],
    ["case_count",              String(bundle.metadata.case_count)],
    ["mapping_summary",         JSON.stringify(bundle.metadata.mapping_summary)],
    ["table_counts",            JSON.stringify(bundle.metadata.table_counts)],
    ["deidentification",        JSON.stringify(bundle.metadata.deidentification)],
    ["note",                    bundle.metadata.note],
  ].map(([key, value]) => ({ key, value: value ?? "" }))
  const warningRows = bundle.metadata.quality_warnings.map(w => ({
    code: w.code,
    severity: w.severity,
    count: w.count ?? "",
    message: w.message,
  }))

  const tables: [string, Record<string, unknown>[]][] = [
    ["metadata",             metadataRows],
    ["quality_warnings",     warningRows],
    ["visit_occurrence",     bundle.visit_occurrence     as unknown as Record<string, unknown>[]],
    ["condition_occurrence", bundle.condition_occurrence as unknown as Record<string, unknown>[]],
    ["drug_exposure",        bundle.drug_exposure        as unknown as Record<string, unknown>[]],
    ["measurement",          bundle.measurement          as unknown as Record<string, unknown>[]],
    ["procedure_occurrence", bundle.procedure_occurrence as unknown as Record<string, unknown>[]],
    ["observation",          bundle.observation          as unknown as Record<string, unknown>[]],
  ]

  for (const [tableName, rows] of tables) {
    if (rows.length === 0) continue
    sections.push(`## ${tableName}`)
    const headers = Object.keys(rows[0])
    sections.push(headers.join(","))
    for (const row of rows) {
      sections.push(
        headers.map(h => {
          const v = row[h]
          if (v == null) return ""
          const s = String(v)
          return s.includes(",") || s.includes('"') || s.includes("\n")
            ? `"${s.replace(/"/g, '""')}"`
            : s
        }).join(",")
      )
    }
    sections.push("")
  }

  return sections.join("\n")
}
