import type { AuthUser } from "@/lib/mobile-auth"
import type { ClinicalPresetScope } from "@/generated/prisma/enums"
import { ClinicalRuleServiceError } from "./errors"

/**
 * Who may see and change a clinical ruleset, by scope.
 *
 * Split out of service.ts because it answers a different question from the
 * rest of that file: not "what does this ruleset contain" but "may this
 * account touch it". The two were interleaved across 1250 lines, so the
 * permission rules -- the ones that decide whether a head of department can
 * edit another institution's dosing -- were the hardest part of the module to
 * find and the easiest to change by accident.
 *
 * Distinct from ./authoring-scope, which guards what a rule *payload* may say.
 * This guards what an *actor* may do to a preset.
 *
 * Three scopes, narrowing:
 *  - PLATFORM   the shipped baseline; only an administrator writes it, and
 *               everyone else sees it once published.
 *  - INSTITUTION a hospital's own overrides; its head of department writes it,
 *               its members see it once published.
 *  - USER       a personal ruleset, visible and writable only to its owner.
 */

export function allowedManagementScopes(
  actor: Pick<AuthUser, "role" | "institutionId">,
): ClinicalPresetScope[] {
  if (actor.role === "ADMIN") return ["PLATFORM", "USER"]
  if (actor.role === "HEAD_OF_DEPT" && actor.institutionId) {
    return ["INSTITUTION", "USER"]
  }
  return ["USER"]
}

export function defaultManagementScope(
  actor: Pick<AuthUser, "role" | "institutionId">,
): ClinicalPresetScope {
  return allowedManagementScopes(actor)[0]!
}

export function resolveManagementScope(
  actor: Pick<AuthUser, "role" | "institutionId">,
  requestedScope?: ClinicalPresetScope | null,
): ClinicalPresetScope {
  const scope = requestedScope ?? defaultManagementScope(actor)
  if (!allowedManagementScopes(actor).includes(scope)) {
    throw new ClinicalRuleServiceError(403, "The requested clinical ruleset scope is not manageable by this account")
  }
  return scope
}

export function assertScopeOwner(input: {
  actor: AuthUser
  scope: ClinicalPresetScope
  ownerInstitutionId: string | null
  ownerUserId: string | null
}) {
  if (input.scope === "PLATFORM") {
    if (input.actor.role !== "ADMIN") {
      throw new ClinicalRuleServiceError(403, "Platform administrator required")
    }
    return
  }
  if (input.scope === "INSTITUTION") {
    if (!input.ownerInstitutionId) {
      throw new ClinicalRuleServiceError(400, "Institution is required")
    }
    if (
      input.actor.role !== "HEAD_OF_DEPT"
      || input.actor.institutionId !== input.ownerInstitutionId
    ) {
      throw new ClinicalRuleServiceError(403, "Head of department required")
    }
    return
  }
  if (!input.ownerUserId || input.ownerUserId !== input.actor.id) {
    throw new ClinicalRuleServiceError(403, "Personal rulesets belong to the current user")
  }
}

export function assertCanEditPreset(actor: AuthUser, preset: {
  scope: ClinicalPresetScope
  ownerInstitutionId: string | null
  ownerUserId: string | null
}) {
  assertScopeOwner({
    actor,
    scope: preset.scope,
    ownerInstitutionId: preset.ownerInstitutionId,
    ownerUserId: preset.ownerUserId,
  })
}

/**
 * Read access is wider than write, and status-dependent: a draft is visible
 * only to whoever may edit it, so an unpublished institution ruleset does not
 * leak to the department before its head has finished it.
 */
export function canReadPreset(actor: AuthUser, preset: {
  scope: ClinicalPresetScope
  status: string
  ownerInstitutionId: string | null
  ownerUserId: string | null
}): boolean {
  if (preset.scope === "PLATFORM") {
    return actor.role === "ADMIN" || preset.status === "PUBLISHED"
  }
  if (preset.scope === "INSTITUTION") {
    return preset.ownerInstitutionId === actor.institutionId
      && (actor.role === "HEAD_OF_DEPT" || preset.status === "PUBLISHED")
  }
  return preset.ownerUserId === actor.id
}
