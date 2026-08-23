import type { mapCasesToOmop } from "@/lib/omop-mapper"

type AnyCase = Parameters<typeof mapCasesToOmop>[0][number]

/**
 * A paediatric case with the scores and provenance only children carry.
 *
 * The dictionary consistency check needs it as well as the adult fixture: an
 * adult case emits none of the paediatric variables, so a check run only
 * against one would report a clean bill while every POVOC, COLDS, PAED and
 * pain-scale code went undocumented. A fixture gap and a documentation gap
 * look identical from inside the test.
 */
export function pediatricCaseFixture(): AnyCase {
  return {
    id: "case-pediatric-omop",
    researchId: "20000000-0000-4000-8000-000000000001",
    createdAt: new Date("2026-07-29T08:00:00Z"),
    status: "COMPLETE",
    finalizations: [{ id: "pediatric-finalization-1" }],
    clinicalMode: "PEDIATRIC",
    clinicalRulesVersion: "2026.08.04-release.1",
    preop: {
      ageYears: 0,
      ageValue: 14,
      ageUnit: "DAYS",
      ageApproxDays: 14,
      bodySurfaceAreaM2: 0.35,
      pediatricFasting: { ruleVersion: "APAGBI-2018", compliant: true },
      sex: "FEMALE",
      povocScore: 2,
      povocRiskPercent: 30,
      coldsScore: 8,
    },
    intraop: {
      startedAt: new Date("2026-07-29T09:00:00Z"),
      endedAt: new Date("2026-07-29T10:00:00Z"),
      startTime: null,
      endTime: null,
    },
    postop: {
      pediatricPainScale: "FLACC",
      pediatricPainScore: 3,
      paedScore: 7,
      painScoreNRS: null,
    },
  } as unknown as AnyCase
}
