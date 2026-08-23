import type {
  ResearchDataAction,
  ResearchMetadata,
  ResearchPermissionSet,
  ResearchScopeKind,
  ResearchScopeSummary,
} from "@lospor/core/research"
import type { Prisma } from "@/generated/prisma/client"
import type { AuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"

export type ResearchActionScope = ResearchScopeSummary & {
  allInstitutions: boolean
  caseScope: Prisma.CaseWhereInput
}

export type ResearchContext = {
  user: AuthUser
  action: ResearchDataAction
  actionScopes: Record<ResearchDataAction, ResearchActionScope>
  activeScope: ResearchActionScope
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

const ACTIONS: ResearchDataAction[] = ["query", "inspectCases", "export", "exportOmop"]

function emptyScope(kind: ResearchScopeKind = "GRANT"): ResearchActionScope {
  return {
    kind,
    institutionIds: [],
    institutionLabels: [],
    allInstitutions: false,
    caseScope: { id: { in: [] } },
  }
}

function fixedScope(
  kind: ResearchScopeKind,
  institutions: Array<{ id: string; name: string }>,
  allInstitutions = false,
): ResearchActionScope {
  return {
    kind,
    institutionIds: institutions.map(item => item.id),
    institutionLabels: institutions.map(item => item.name),
    allInstitutions,
    caseScope: { institutionId: { in: institutions.map(item => item.id) } },
  }
}

function activateResearchScope(
  context: Omit<ResearchContext, "action" | "activeScope" | "scopeKind" | "institutionIds" | "institutionLabels" | "caseScope">,
  action: ResearchDataAction,
): ResearchContext {
  const activeScope = context.actionScopes[action]
  return {
    ...context,
    action,
    activeScope,
    scopeKind: activeScope.kind,
    institutionIds: activeScope.institutionIds,
    institutionLabels: activeScope.institutionLabels,
    caseScope: activeScope.caseScope,
  }
}

export function researchContextForAction(
  context: ResearchContext,
  action: ResearchDataAction,
): ResearchContext {
  return activateResearchScope({
    user: context.user,
    actionScopes: context.actionScopes,
    permissions: context.permissions,
  }, action)
}

export async function resolveResearchContext(user: AuthUser): Promise<ResearchContext | null> {
  // Account audience is orthogonal to research authorization. Clinical
  // Members, HODs, and Admins may all receive explicit grants; RESEARCH_ONLY
  // accounts still require a grant and remain blocked from clinical routes.
  // The legacy roles stay readable only for migration compatibility.
  const clinicalRole = ["MEMBER", "HEAD_OF_DEPT", "ADMIN", "CLINICIAN"].includes(user.role)
  const eligible = user.accountKind === "RESEARCH_ONLY"
    || user.role === "RESEARCHER"
    || (user.accountKind === "CLINICAL" && clinicalRole)
  if (!eligible) return null

  const now = new Date()
  const [grants, selfAuthorization] = await Promise.all([
    prisma.researchAccessGrant.findMany({
      where: {
        userId: user.id,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      include: { institution: { select: { id: true, name: true } } },
    }),
    user.accountKind === "CLINICAL" && user.role !== "ADMIN"
      ? prisma.researchSelfAuthorization.findFirst({
          where: { userId: user.id, expiresAt: { gt: now } },
          include: { institution: { select: { id: true, name: true } } },
          orderBy: { createdAt: "desc" },
        })
      : Promise.resolve(null),
  ])
  // Admins receive aggregate query across the appliance, and nothing else
  // implicitly. Inspection, export, OMOP, and sharing still come only from a
  // live explicit grant. HOD and Member roles confer no research entitlement.
  const hasAdminAggregate = user.role === "ADMIN" && user.accountKind === "CLINICAL"
  if (!hasAdminAggregate && !grants.length && !selfAuthorization) return null

  const needsAllInstitutions = hasAdminAggregate || grants.some(grant => grant.allInstitutions)
  const allInstitutions = needsAllInstitutions
    ? await prisma.institution.findMany({
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      })
    : []

  const actionGrants = (action: ResearchDataAction) => grants.filter(grant => {
    if (action === "query") return grant.canQuery
    if (action === "inspectCases") return grant.canInspectCases
    if (action === "export") return grant.canExport
    return grant.canExport && grant.canExportOmop
  })
  const scopeFor = (action: ResearchDataAction): ResearchActionScope => {
    const permitted = actionGrants(action)
    if (!permitted.length) return emptyScope()
    if (permitted.some(grant => grant.allInstitutions)) {
      return fixedScope("ALL", allInstitutions, true)
    }
    const institutions = permitted
      .flatMap(grant => grant.institution ? [grant.institution] : [])
      .filter((institution, index, values) =>
        values.findIndex(value => value.id === institution.id) === index)
    return fixedScope("GRANT", institutions)
  }

  const actionScopes = {
    query: hasAdminAggregate
      ? fixedScope("ALL", allInstitutions, true)
      : (() => {
          const granted = scopeFor("query")
          if (!selfAuthorization || granted.allInstitutions) return granted
          const institutions = [
            ...grants
              .filter(grant => grant.canQuery && grant.institution)
              .map(grant => grant.institution!),
            selfAuthorization.institution,
          ].filter((institution, index, values) =>
            values.findIndex(value => value.id === institution.id) === index)
          return fixedScope("GRANT", institutions)
        })(),
    inspectCases: scopeFor("inspectCases"),
    export: scopeFor("export"),
    exportOmop: scopeFor("exportOmop"),
  }

  const canQuery = hasAdminAggregate || actionGrants("query").length > 0 || !!selfAuthorization
  const canShare = grants.some(grant => grant.canQuery && grant.canShareCohorts)

  return activateResearchScope({
    user,
    actionScopes,
    permissions: {
      ...DENIED,
      query: canQuery,
      compare: canQuery,
      benchmark: canQuery,
      savePrivateCohorts: canQuery,
      inspectCases: actionGrants("inspectCases").length > 0,
      shareInstitutionCohorts: canShare,
      export: actionGrants("export").length > 0,
      exportOmop: actionGrants("exportOmop").length > 0,
      // This generic upstream endpoint remains available to the public demo's
      // Admin. The Hospital overlay denies it; appliance grants are operated
      // through Status so clinical Admin credentials never become operator
      // credentials.
      manageAccess: user.role === "ADMIN" && user.accountKind === "CLINICAL",
    },
  }, "query")
}

export function metadataScope(
  context: ResearchContext,
  action: ResearchDataAction = "query",
): ResearchMetadata["scope"] {
  const scope = context.actionScopes[action]
  return {
    kind: scope.kind,
    institutionIds: scope.institutionIds,
    institutionLabels: scope.institutionLabels,
  }
}

export function metadataScopes(context: ResearchContext): ResearchMetadata["scopes"] {
  return Object.fromEntries(ACTIONS.map(action => [action, metadataScope(context, action)])) as ResearchMetadata["scopes"]
}

export function canInspectEntireQueryScope(context: ResearchContext): boolean {
  void context
  // Aggregate disclosure policy does not weaken when row inspection is also
  // granted. Counts 1-4 and complementary cells remain protected in aggregate,
  // comparison, benchmark, and quality responses for every role.
  return false
}

export function canUseInstitution(
  context: ResearchContext,
  institutionId: string,
  action: ResearchDataAction = context.action,
): boolean {
  const scope = context.actionScopes[action]
  return scope.allInstitutions || scope.institutionIds.includes(institutionId)
}
