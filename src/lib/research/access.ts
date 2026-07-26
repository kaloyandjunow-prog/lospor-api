import type { ResearchMetadata, ResearchPermissionSet, ResearchScopeKind } from "@lospor/core/research"
import type { Prisma } from "@/generated/prisma/client"
import type { AuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"

export type ResearchContext = {
  user: AuthUser
  scopeKind: ResearchScopeKind
  institutionIds: string[]
  institutionLabels: string[]
  caseScope: Prisma.CaseWhereInput
  permissions: ResearchPermissionSet
}

const DENIED: ResearchPermissionSet = {
  query: false,
  inspectCases: false,
  compare: false,
  benchmark: false,
  savePrivateCohorts: false,
  shareInstitutionCohorts: false,
  export: false,
  exportOmop: false,
  manageAccess: false,
}

function allowed(overrides: Partial<ResearchPermissionSet>): ResearchPermissionSet {
  return {
    ...DENIED,
    query: true,
    compare: true,
    benchmark: true,
    savePrivateCohorts: true,
    ...overrides,
  }
}

export async function resolveResearchContext(user: AuthUser): Promise<ResearchContext | null> {
  if (user.role === "ADMIN") {
    const institutions = await prisma.institution.findMany({
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    })
    return {
      user,
      scopeKind: "ALL",
      institutionIds: institutions.map(item => item.id),
      institutionLabels: institutions.map(item => item.name),
      caseScope: {},
      permissions: allowed({
        inspectCases: true,
        shareInstitutionCohorts: true,
        export: true,
        exportOmop: true,
        manageAccess: true,
      }),
    }
  }

  if (user.role === "HEAD_OF_DEPT" && user.institutionId) {
    return {
      user,
      scopeKind: "INSTITUTION",
      institutionIds: [user.institutionId],
      institutionLabels: [user.institutionName ?? "Institution"],
      caseScope: { institutionId: user.institutionId },
      permissions: allowed({
        inspectCases: true,
        shareInstitutionCohorts: true,
        export: true,
      }),
    }
  }

  if (user.role !== "RESEARCHER") return null

  const now = new Date()
  const grants = await prisma.researchAccessGrant.findMany({
    where: {
      userId: user.id,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    include: { institution: { select: { id: true, name: true } } },
  })
  if (!grants.length) return null

  const allInstitutions = grants.some(grant => grant.allInstitutions)
  const institutions = grants
    .flatMap(grant => grant.institution ? [grant.institution] : [])
    .filter((institution, index, values) =>
      values.findIndex(value => value.id === institution.id) === index)

  return {
    user,
    scopeKind: allInstitutions ? "ALL" : "GRANT",
    institutionIds: institutions.map(item => item.id),
    institutionLabels: institutions.map(item => item.name),
    caseScope: allInstitutions
      ? {}
      : { institutionId: { in: institutions.map(item => item.id) } },
    permissions: allowed({
      inspectCases: grants.some(grant => grant.canInspectCases),
      export: grants.some(grant => grant.canExport),
      exportOmop: grants.some(grant => grant.canExportOmop),
    }),
  }
}

export function metadataScope(context: ResearchContext): ResearchMetadata["scope"] {
  return {
    kind: context.scopeKind,
    institutionIds: context.institutionIds,
    institutionLabels: context.institutionLabels,
  }
}

export function canUseInstitution(context: ResearchContext, institutionId: string): boolean {
  return context.scopeKind === "ALL" || context.institutionIds.includes(institutionId)
}
