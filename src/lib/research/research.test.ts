import { beforeEach, describe, expect, it, vi } from "vitest"

const { findInstitutions, findGrants, findSelfAuthorization, queryRaw } = vi.hoisted(() => ({
  findInstitutions: vi.fn(),
  findGrants: vi.fn(),
  findSelfAuthorization: vi.fn(),
  queryRaw: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    institution: { findMany: findInstitutions },
    researchAccessGrant: { findMany: findGrants },
    researchSelfAuthorization: { findFirst: findSelfAuthorization },
    $queryRaw: queryRaw,
  },
}))

import { researchContextForAction, resolveResearchContext } from "./access"
import { compileResearchWhere } from "./cohort-where"
import { researchCohortSchema, researchQuerySchema } from "./schemas"
import { distribution, metric } from "./mappers"

const baseUser = {
  id: "user-1",
  role: "MEMBER",
  institutionId: "inst-1",
  institutionName: "Hospital",
  firstName: "Test",
  lastName: "User",
  title: null,
  jti: null,
  clientType: "WEB" as const,
  accountKind: "CLINICAL" as const,
  preferredLocale: "bg" as const,
}

describe("research access and query contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    findInstitutions.mockResolvedValue([
      { id: "inst-1", name: "Hospital A" },
      { id: "inst-2", name: "Hospital B" },
    ])
    findGrants.mockResolvedValue([])
    findSelfAuthorization.mockResolvedValue(null)
  })

  it("rejects ordinary clinical accounts", async () => {
    await expect(resolveResearchContext(baseUser)).resolves.toBeNull()
  })

  it("does not give department heads implicit research access", async () => {
    await expect(resolveResearchContext({ ...baseUser, role: "HEAD_OF_DEPT" }))
      .resolves.toBeNull()
  })

  it("gives administrators aggregate-only global access", async () => {
    const context = await resolveResearchContext({ ...baseUser, role: "ADMIN" })
    expect(context).toMatchObject({
      scopeKind: "ALL",
      institutionIds: ["inst-1", "inst-2"],
      permissions: {
        query: true,
        inspectCases: false,
        export: false,
        exportOmop: false,
        shareInstitutionCohorts: false,
        manageAccess: true,
      },
    })
  })

  it("builds researcher scope from active grants", async () => {
    findGrants.mockResolvedValue([{
      institution: { id: "inst-2", name: "Hospital B" },
      allInstitutions: false,
      canQuery: true,
      canInspectCases: true,
      canExport: true,
      canExportOmop: false,
      canShareCohorts: false,
    }])
    const context = await resolveResearchContext({ ...baseUser, role: "RESEARCHER" })
    expect(context).toMatchObject({
      scopeKind: "GRANT",
      institutionIds: ["inst-2"],
      caseScope: { institutionId: { in: ["inst-2"] } },
      permissions: { inspectCases: true, export: true, exportOmop: false },
    })
  })

  it("builds the same grant scope for an ordinary-role research-only account", async () => {
    findGrants.mockResolvedValue([{
      institution: { id: "inst-2", name: "Hospital B" },
      allInstitutions: false,
      canQuery: true,
      canInspectCases: false,
      canExport: false,
      canExportOmop: false,
      canShareCohorts: false,
    }])
    const context = await resolveResearchContext({
      ...baseUser,
      role: "MEMBER",
      accountKind: "RESEARCH_ONLY",
    })
    expect(context).toMatchObject({
      scopeKind: "GRANT",
      institutionIds: ["inst-2"],
      permissions: { query: true, inspectCases: false },
    })
  })

  it("rejects arbitrary query properties", () => {
    expect(researchQuerySchema.safeParse({
      cohort: { version: 1, filters: {} },
      sql: "select * from User",

    }).success).toBe(false)
  })
  it("keeps every permission inside the institutions that granted it", async () => {
    findGrants.mockResolvedValue([
      {
        institution: { id: "inst-1", name: "Hospital A" },
        allInstitutions: false,
        canQuery: true,
        canInspectCases: true,
        canExport: true,
        canExportOmop: false,
        canShareCohorts: false,
      },
      {
        institution: { id: "inst-2", name: "Hospital B" },
        allInstitutions: false,
        canQuery: true,
        canInspectCases: false,
        canExport: false,
        canExportOmop: false,
        canShareCohorts: false,
      },
    ])
    const context = await resolveResearchContext({ ...baseUser, role: "RESEARCHER" })
    expect(context?.actionScopes.query.institutionIds).toEqual(["inst-1", "inst-2"])
    expect(context?.actionScopes.inspectCases.institutionIds).toEqual(["inst-1"])
    expect(context?.actionScopes.export.institutionIds).toEqual(["inst-1"])
    expect(context?.actionScopes.exportOmop.institutionIds).toEqual([])
  })

  it("does not let a narrow export grant inherit an all-institutions query scope", async () => {
    findGrants.mockResolvedValue([
      {
        institution: null,
        allInstitutions: true,
        canQuery: true,
        canInspectCases: false,
        canExport: false,
        canExportOmop: false,
        canShareCohorts: false,
      },
      {
        institution: { id: "inst-2", name: "Hospital B" },
        allInstitutions: false,
        canQuery: true,
        canInspectCases: false,
        canExport: true,
        canExportOmop: true,
        canShareCohorts: false,
      },
    ])
    const context = await resolveResearchContext({ ...baseUser, role: "RESEARCHER" })
    expect(context?.actionScopes.query.allInstitutions).toBe(true)
    expect(researchContextForAction(context!, "export").institutionIds).toEqual(["inst-2"])
    expect(researchContextForAction(context!, "exportOmop").institutionIds).toEqual(["inst-2"])
  })

  it("compiles clinical filters into fixed Prisma predicates", async () => {
    findSelfAuthorization.mockResolvedValue({
      institution: { id: "inst-1", name: "Hospital A" },
    })
    const context = await resolveResearchContext({ ...baseUser, role: "HEAD_OF_DEPT" })
    expect(context).not.toBeNull()
    const where = await compileResearchWhere(researchCohortSchema.parse({
      version: 1,
      filters: {
        statuses: ["COMPLETE"],
        clinicalModes: ["PEDIATRIC"],
        ageDays: { min: 30, max: 365 },
        ageYears: { min: 40, max: 70 },
        diagnosisCodes: ["C61"],
        emergency: false,
        finalized: { from: "2026-07-01", to: "2026-07-25" },
        techniques: ["GENERAL_BALANCED"],
      },
    }), context!)

    expect(where).toEqual({
      AND: expect.arrayContaining([
        { institutionId: { in: ["inst-1"] } },
        { clinicalMode: { in: ["PEDIATRIC"] } },
        { preop: { is: expect.objectContaining({
          ageApproxDays: { gte: 30, lte: 365 },
          ageYears: { gte: 40, lte: 70 },
          emergencySurgery: false,
        }) } },
        {
          selections: {
            some: {
              category: "technique",
              value: { in: ["GENERAL_BALANCED"] },
            },
          },
        },
        { finalizedAt: {
          gte: new Date("2026-07-01T00:00:00.000Z"),
          lt: new Date("2026-07-26T00:00:00.000Z"),
        } },
        { status: { in: ["COMPLETE"] } },
      ]),
    })
  })

  it("suppresses small metric and distribution cells", () => {
    expect(metric("ponvRate", 83.3, 6, { binary: true, numerator: 5, unit: "percent" })).toMatchObject({
      value: null,
      suppressed: true,
    })
    expect(metric("ponvRate", 25, 4, { binary: true, numerator: 1, unit: "percent" })).toMatchObject({
      value: null,
      suppressed: true,
    })
    const buckets = new Map([
      ["ICU", { label: "ICU", cases: new Set(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]) }],
      ["PACU", { label: "PACU", cases: new Set(["1", "2", "3", "4"]) }],
      ["WARD", { label: "Ward", cases: new Set(["1", "2", "3", "4", "5"]) }],
    ])
    expect(distribution("disposition", buckets).buckets).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "PACU", count: null, suppressed: true }),
      expect.objectContaining({ key: "WARD", count: null, suppressed: true }),
      expect.objectContaining({ key: "ICU", count: 10, suppressed: false }),
    ]))
  })
})
