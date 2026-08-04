import { randomUUID } from "node:crypto"
import {
  FIXED_EQUIPMENT_RULE_REJECTION_MESSAGE,
  clinicalPresetRulesToEffective,
  clinicalRuleKey,
  isLegacyEquipmentRuleKind,
  validateClinicalRuleCollection,
  validateClinicalRuleCollectionForPublication,
  validateClinicalRulePayload,
  type ClinicalPresetDto,
  type ClinicalPresetRule,
  type ClinicalPresetScope,
  type ClinicalRuleMode,
  type ClinicalRulePayload,
  type ClinicalRulesWorkbenchDto,
  type ClinicalRulesetSelectionDto,
  type EffectiveClinicalRule,
} from "@lospor/core/clinical-rules"
import { Prisma } from "@/generated/prisma/client"
import type { AuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"
import { scopeGuardIssues } from "./authoring-scope"

const personSelect = {
  id: true,
  name: true,
  firstName: true,
  lastName: true,
  title: true,
  role: true,
} satisfies Prisma.UserSelect

const presetInclude = {
  rules: { orderBy: { ruleKey: "asc" as const } },
  ownerInstitution: { select: { id: true, name: true } },
  ownerUser: { select: personSelect },
  _count: {
    select: {
      institutionSelections: true,
    },
  },
} satisfies Prisma.ClinicalPresetInclude

type PresetWithDetails = Prisma.ClinicalPresetGetPayload<{
  include: typeof presetInclude
}>

function rawPayloadKind(value: unknown): string | null {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof (value as { kind?: unknown }).kind === "string"
    ? (value as { kind: string }).kind
    : null
}

function isLegacyEquipmentRule(input: {
  ruleKey?: string | null
  payload?: unknown
}): boolean {
  const kind = rawPayloadKind(input.payload)
  if (isLegacyEquipmentRuleKind(kind)) return true
  const keyKind = input.ruleKey?.split(":", 1)[0]
  return isLegacyEquipmentRuleKind(keyKind)
}

function editableRules(rules: ReadonlyArray<PresetWithDetails["rules"][number]>) {
  return rules.filter(rule => !isLegacyEquipmentRule(rule))
}

function personName(person: {
  name: string
  firstName: string
  lastName: string
  title?: string | null
} | null): string | null {
  if (!person) return null
  const full = [person.title, person.firstName, person.lastName]
    .filter(Boolean)
    .join(" ")
    .trim()
  return full || person.name
}

function stringArray(value: Prisma.JsonValue): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : []
}

function payload(value: Prisma.JsonValue): ClinicalRulePayload {
  const parsed = validateClinicalRulePayload(value)
  if (!parsed.valid) {
    throw new Error(`Invalid stored clinical rule: ${JSON.stringify(parsed.issues)}`)
  }
  return parsed.value
}

function mapPresetRule(rule: {
  id: string
  ruleKey: string
  ruleVersion: string
  payload: Prisma.JsonValue
  sourceRefs: Prisma.JsonValue
}): ClinicalPresetRule {
  return {
    id: rule.id,
    ruleKey: rule.ruleKey,
    ruleVersion: rule.ruleVersion,
    payload: payload(rule.payload),
    sourceRefs: stringArray(rule.sourceRefs),
  }
}

function mapPreset(item: PresetWithDetails): ClinicalPresetDto {
  return {
    id: item.id,
    key: item.key,
    name: item.name,
    description: item.description,
    clinicalMode: item.clinicalMode,
    scope: item.scope,
    ownerInstitutionId: item.ownerInstitutionId,
    ownerInstitutionName: item.ownerInstitution?.name ?? null,
    ownerUserId: item.ownerUserId,
    ownerUserName: personName(item.ownerUser),
    copiedFromPresetId: item.copiedFromPresetId,
    copiedFromVersion: item.copiedFromVersion,
    version: item.version,
    status: item.status,
    rules: editableRules(item.rules).map(mapPresetRule),
    assignedInstitutionCount: item._count.institutionSelections,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
    publishedAt: item.publishedAt?.toISOString() ?? null,
  }
}

function normalizeKey(value: string): string {
  const key = value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")
  if (!key || key.length > 80) {
    throw new ClinicalRuleServiceError(400, "Ruleset key must contain 1-80 letters, numbers or underscores")
  }
  return key
}

function allowedManagementScopes(actor: Pick<AuthUser, "role" | "institutionId">): ClinicalPresetScope[] {
  if (actor.role === "ADMIN") return ["PLATFORM", "USER"]
  if (actor.role === "HEAD_OF_DEPT" && actor.institutionId) {
    return ["INSTITUTION", "USER"]
  }
  return ["USER"]
}

function defaultManagementScope(actor: Pick<AuthUser, "role" | "institutionId">): ClinicalPresetScope {
  return allowedManagementScopes(actor)[0]!
}

function resolveManagementScope(
  actor: Pick<AuthUser, "role" | "institutionId">,
  requestedScope?: ClinicalPresetScope | null,
): ClinicalPresetScope {
  const scope = requestedScope ?? defaultManagementScope(actor)
  if (!allowedManagementScopes(actor).includes(scope)) {
    throw new ClinicalRuleServiceError(403, "The requested clinical ruleset scope is not manageable by this account")
  }
  return scope
}

function assertScopeOwner(input: {
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

function assertCanEditPreset(actor: AuthUser, preset: {
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

function canReadPreset(actor: AuthUser, preset: {
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

async function requirePreset(presetId: string): Promise<PresetWithDetails> {
  const preset = await prisma.clinicalPreset.findUnique({
    where: { id: presetId },
    include: presetInclude,
  })
  if (!preset) throw new ClinicalRuleServiceError(404, "Ruleset not found")
  return preset
}

/**
 * The published platform rule for this key, which institution and personal
 * layers are allowed to narrow but never to invent beyond.
 */
async function platformBaselineRule(
  clinicalMode: ClinicalRuleMode,
  ruleKey: string,
): Promise<ClinicalRulePayload | null> {
  const rule = await prisma.clinicalPresetRule.findFirst({
    where: {
      ruleKey,
      preset: { scope: "PLATFORM", clinicalMode, status: "PUBLISHED" },
    },
    orderBy: { preset: { version: "desc" } },
    select: { payload: true },
  })
  return (rule?.payload ?? null) as ClinicalRulePayload | null
}

async function requireEditablePreset(actor: AuthUser, presetId: string): Promise<PresetWithDetails> {
  const preset = await requirePreset(presetId)
  assertCanEditPreset(actor, preset)
  if (preset.status !== "DRAFT") {
    throw new ClinicalRuleServiceError(409, "Published rulesets are immutable; copy one to make changes")
  }
  return preset
}

type EffectiveRuleset = {
  presetId: string | null
  presetName: string | null
  presetVersion: number | null
  scope: ClinicalPresetScope | null
  rules: EffectiveClinicalRule[]
}

export async function effectiveClinicalRulesForUser(
  actor: Pick<AuthUser, "id" | "institutionId">,
  clinicalMode: ClinicalRuleMode,
): Promise<EffectiveRuleset> {
  return effectiveClinicalRulesForScope(
    actor,
    clinicalMode,
    "USER",
    actor.institutionId,
  )
}

async function effectiveClinicalRulesForScope(
  actor: Pick<AuthUser, "id" | "institutionId">,
  clinicalMode: ClinicalRuleMode,
  managementScope: ClinicalPresetScope,
  institutionId: string | null = actor.institutionId,
): Promise<EffectiveRuleset> {
  const [userSelection, institutionSelection, platformSelection] = await Promise.all([
    managementScope === "USER"
      ? prisma.userClinicalPresetSelection.findUnique({
          where: {
            userId_clinicalMode: {
              userId: actor.id,
              clinicalMode,
            },
          },
          include: {
            preset: {
              include: { rules: { orderBy: { ruleKey: "asc" } } },
            },
          },
        })
      : null,
    managementScope !== "PLATFORM" && institutionId
      ? prisma.institutionClinicalPresetSelection.findUnique({
          where: {
            institutionId_clinicalMode: {
              institutionId,
              clinicalMode,
            },
          },
          include: {
            preset: {
              include: { rules: { orderBy: { ruleKey: "asc" } } },
            },
          },
        })
      : null,
    prisma.platformClinicalPresetSelection.findUnique({
      where: { clinicalMode },
      include: {
        preset: {
          include: { rules: { orderBy: { ruleKey: "asc" } } },
        },
      },
    }),
  ])

  const candidates = [
    userSelection?.preset,
    institutionSelection?.preset,
    platformSelection?.preset,
  ]
  const preset = candidates.find(candidate =>
    !!candidate
    && candidate.status === "PUBLISHED"
    && candidate.clinicalMode === clinicalMode,
  )
  if (!preset) {
    return {
      presetId: null,
      presetName: null,
      presetVersion: null,
      scope: null,
      rules: [],
    }
  }
  return {
    presetId: preset.id,
    presetName: preset.name,
    presetVersion: preset.version,
    scope: preset.scope,
    rules: clinicalPresetRulesToEffective(
      preset.id,
      preset.scope,
      editableRules(preset.rules).map(mapPresetRule),
    ),
  }
}

async function selectionsForUser(
  actor: AuthUser,
  managementScope: ClinicalPresetScope,
): Promise<ClinicalRulesetSelectionDto[]> {
  return Promise.all((["ADULT", "PEDIATRIC"] as const).map(async clinicalMode => {
    const [platform, institution, user, effective] = await Promise.all([
      prisma.platformClinicalPresetSelection.findUnique({
        where: { clinicalMode },
        select: { presetId: true },
      }),
      managementScope !== "PLATFORM" && actor.institutionId
        ? prisma.institutionClinicalPresetSelection.findUnique({
            where: {
              institutionId_clinicalMode: {
                institutionId: actor.institutionId,
                clinicalMode,
              },
            },
            select: { presetId: true },
          })
        : null,
      managementScope === "USER"
        ? prisma.userClinicalPresetSelection.findUnique({
            where: {
              userId_clinicalMode: {
                userId: actor.id,
                clinicalMode,
              },
            },
            select: { presetId: true },
          })
        : null,
      effectiveClinicalRulesForScope(
        actor,
        clinicalMode,
        managementScope,
        actor.institutionId,
      ),
    ])
    return {
      clinicalMode,
      platformPresetId: platform?.presetId ?? null,
      institutionPresetId: managementScope === "PLATFORM"
        ? null
        : institution?.presetId ?? null,
      userPresetId: managementScope === "USER" ? user?.presetId ?? null : null,
      effectivePresetId: effective.presetId,
      effectivePresetName: effective.presetName,
      effectiveScope: effective.scope,
      effectiveVersion: effective.presetVersion,
    }
  }))
}

export async function loadClinicalRulesWorkbench(
  actor: AuthUser,
  requestedScope?: ClinicalPresetScope | null,
  clinicalMode: ClinicalRuleMode = "ADULT",
): Promise<ClinicalRulesWorkbenchDto> {
  const activeScope = resolveManagementScope(actor, requestedScope)
  const allowedScopes = allowedManagementScopes(actor)
  const visibility: Prisma.ClinicalPresetWhereInput[] = []

  if (activeScope === "PLATFORM") {
    visibility.push({ scope: "PLATFORM" })
  } else {
    visibility.push({ scope: "PLATFORM", status: "PUBLISHED" })
  }
  if (activeScope === "INSTITUTION") {
    visibility.push({
      scope: "INSTITUTION",
      ownerInstitutionId: actor.institutionId,
    })
  }
  if (activeScope === "USER") {
    visibility.push({
      scope: "USER",
      ownerUserId: actor.id,
    })
    if (actor.institutionId) {
      visibility.push({
        scope: "INSTITUTION",
        ownerInstitutionId: actor.institutionId,
        status: "PUBLISHED",
      })
    }
  }

  const [presets, institutions, selections, effective] = await Promise.all([
    prisma.clinicalPreset.findMany({
      where: { clinicalMode, OR: visibility },
      include: presetInclude,
      orderBy: [
        { clinicalMode: "asc" },
        { scope: "asc" },
        { updatedAt: "desc" },
      ],
    }),
    prisma.institution.findMany({
      where: actor.role === "HEAD_OF_DEPT"
        ? { id: actor.institutionId ?? "__none__" }
        : { id: "__none__" },
      select: { id: true, name: true, city: true },
      orderBy: [{ name: "asc" }, { city: "asc" }],
    }),
    selectionsForUser(actor, activeScope),
    effectiveClinicalRulesForScope(
      actor,
      clinicalMode,
      activeScope,
      actor.institutionId,
    ),
  ])

  return {
    clinicalMode,
    actor: {
      id: actor.id,
      role: actor.role,
      institutionId: actor.institutionId,
      institutionName: actor.institutionName,
    },
    management: {
      activeScope,
      defaultScope: defaultManagementScope(actor),
      allowedScopes,
      ownerInstitutionId: activeScope === "INSTITUTION" ? actor.institutionId : null,
      ownerInstitutionName: activeScope === "INSTITUTION" ? actor.institutionName : null,
    },
    presets: presets.map(mapPreset),
    institutions: institutions.map(item => ({
      id: item.id,
      name: item.name,
      city: item.city,
    })),
    reviewers: [],
    overrides: [],
    effectiveRules: effective.rules,
    selections,
  }
}

export async function createClinicalRuleset(input: {
  actor: AuthUser
  scope: ClinicalPresetScope
  clinicalMode: ClinicalRuleMode
  key: string
  name: string
  description?: string | null
  copyFromPresetId?: string | null
  institutionId?: string | null
}) {
  const ownerInstitutionId = input.scope === "INSTITUTION"
    ? input.institutionId ?? input.actor.institutionId
    : null
  const ownerUserId = input.scope === "USER" ? input.actor.id : null
  assertScopeOwner({
    actor: input.actor,
    scope: input.scope,
    ownerInstitutionId,
    ownerUserId,
  })

  const key = normalizeKey(input.key)
  const source = input.copyFromPresetId
    ? await requirePreset(input.copyFromPresetId)
    : null
  if (source && !canReadPreset(input.actor, source)) {
    throw new ClinicalRuleServiceError(403, "The source ruleset is not accessible")
  }
  if (source && source.clinicalMode !== input.clinicalMode) {
    throw new ClinicalRuleServiceError(400, "Adult and pediatric rulesets cannot be mixed")
  }

  const latest = await prisma.clinicalPreset.aggregate({
    where: {
      key,
      clinicalMode: input.clinicalMode,
      scope: input.scope,
      ownerInstitutionId,
      ownerUserId,
    },
    _max: { version: true },
  })
  const version = (latest._max.version ?? 0) + 1
  const id = `ruleset-${randomUUID()}`
  return prisma.$transaction(async tx => {
    const created = await tx.clinicalPreset.create({
      data: {
        id,
        key,
        name: input.name.trim(),
        description: input.description?.trim() || null,
        clinicalMode: input.clinicalMode,
        scope: input.scope,
        ownerInstitutionId,
        ownerUserId,
        copiedFromPresetId: source?.id ?? null,
        copiedFromVersion: source?.version ?? null,
        version,
        createdById: input.actor.id,
      },
    })
    const sourceRules = source ? editableRules(source.rules) : []
    if (sourceRules.length) {
      await tx.clinicalPresetRule.createMany({
        data: sourceRules.map(rule => ({
          presetId: created.id,
          ruleKey: rule.ruleKey,
          ruleVersion: `${key}.v${version}`,
          payload: rule.payload as Prisma.InputJsonValue,
          sourceRefs: rule.sourceRefs as Prisma.InputJsonValue,
        })),
      })
    }
    return created
  })
}

export async function upsertClinicalRulesetRule(input: {
  actor: AuthUser
  presetId: string
  existingRuleKey?: string | null
  payload: unknown
}) {
  if (isLegacyEquipmentRule({
    ruleKey: input.existingRuleKey,
    payload: input.payload,
  })) {
    throw new ClinicalRuleServiceError(400, FIXED_EQUIPMENT_RULE_REJECTION_MESSAGE)
  }
  const preset = await requireEditablePreset(input.actor, input.presetId)
  const parsed = validateClinicalRulePayload(input.payload)
  if (!parsed.valid) {
    throw new ClinicalRuleServiceError(400, "Invalid clinical rule", parsed.issues)
  }
  const modeMatches = preset.clinicalMode === "PEDIATRIC"
    ? parsed.value.kind.startsWith("PEDIATRIC_")
    : parsed.value.kind.startsWith("ADULT_")
  if (!modeMatches) {
    throw new ClinicalRuleServiceError(400, "Rule kind does not match the ruleset mode")
  }
  const ruleKey = clinicalRuleKey(parsed.value)
  // Institution and personal layers may tune presentation, never the schema.
  if (preset.scope !== "PLATFORM") {
    const baseline = await platformBaselineRule(preset.clinicalMode, ruleKey)
    const guardIssues = scopeGuardIssues({
      scope: preset.scope,
      next: parsed.value,
      baseline,
    })
    if (guardIssues.length) {
      throw new ClinicalRuleServiceError(403, "Not permitted at this ruleset scope", guardIssues)
    }
  }
  const collectionValidation = validateClinicalRuleCollection([
    ...editableRules(preset.rules)
      .filter(rule => rule.ruleKey !== (input.existingRuleKey ?? ruleKey))
      .map(rule => mapPresetRule(rule)),
    { ruleKey, payload: parsed.value },
  ])
  if (!collectionValidation.valid) {
    throw new ClinicalRuleServiceError(
      400,
      "Invalid clinical ruleset",
      collectionValidation.issues,
    )
  }
  if (input.existingRuleKey && input.existingRuleKey !== ruleKey) {
    await prisma.clinicalPresetRule.deleteMany({
      where: { presetId: preset.id, ruleKey: input.existingRuleKey },
    })
  }
  return prisma.clinicalPresetRule.upsert({
    where: {
      presetId_ruleKey: {
        presetId: preset.id,
        ruleKey,
      },
    },
    create: {
      presetId: preset.id,
      ruleKey,
      ruleVersion: `${preset.key}.v${preset.version}.${Date.now()}`,
      payload: parsed.value as Prisma.InputJsonValue,
      sourceRefs: [],
    },
    update: {
      ruleVersion: `${preset.key}.v${preset.version}.${Date.now()}`,
      payload: parsed.value as Prisma.InputJsonValue,
    },
  })
}

function pediatricDrugIdentity(payload: ClinicalRulePayload): string | null {
  if (
    payload.kind !== "PEDIATRIC_DRUG_PROFILE"
    && payload.kind !== "PEDIATRIC_DRUG_POLICY"
    && payload.kind !== "PEDIATRIC_DRUG_DOSE"
  ) return null
  return payload.medicationKey.trim().toUpperCase()
}

/**
 * Replaces every age/weight band for one pediatric drug in a single
 * transaction. Saving through the unified editor also retires that drug's
 * legacy policy/indication rows from the draft so there is one source of truth.
 */
export async function replacePediatricDrugProfiles(input: {
  actor: AuthUser
  presetId: string
  medicationKey: string
  profiles: unknown[]
}) {
  const preset = await requireEditablePreset(input.actor, input.presetId)
  if (preset.clinicalMode !== "PEDIATRIC") {
    throw new ClinicalRuleServiceError(400, "Pediatric drug profiles require a pediatric ruleset")
  }
  if (!input.profiles.length) {
    throw new ClinicalRuleServiceError(400, "At least one pediatric drug band is required")
  }
  const medicationIdentity = input.medicationKey.trim().toUpperCase()
  const parsedProfiles = input.profiles.map((profile, index) => {
    const parsed = validateClinicalRulePayload(profile)
    if (!parsed.valid) {
      throw new ClinicalRuleServiceError(
        400,
        `Invalid pediatric drug band ${index + 1}`,
        parsed.issues.map(issue => ({ ...issue, field: `profiles.${index}.${issue.field}` })),
      )
    }
    if (
      parsed.value.kind !== "PEDIATRIC_DRUG_PROFILE"
      || pediatricDrugIdentity(parsed.value) !== medicationIdentity
    ) {
      throw new ClinicalRuleServiceError(
        400,
        `Pediatric drug band ${index + 1} does not belong to ${input.medicationKey}`,
      )
    }
    return parsed.value
  })

  const currentRules = editableRules(preset.rules).map(mapPresetRule)
  const replacedRules = currentRules.filter(rule => (
    pediatricDrugIdentity(rule.payload) === medicationIdentity
    && (
      rule.payload.kind === "PEDIATRIC_DRUG_PROFILE"
      || rule.payload.kind === "PEDIATRIC_DRUG_POLICY"
      || rule.payload.kind === "PEDIATRIC_DRUG_DOSE"
    )
  ))
  const replacementRules = parsedProfiles.map(profile => ({
    ruleKey: clinicalRuleKey(profile),
    payload: profile,
  }))
  const collectionValidation = validateClinicalRuleCollection([
    ...currentRules.filter(rule => !replacedRules.some(item => item.ruleKey === rule.ruleKey)),
    ...replacementRules,
  ])
  if (!collectionValidation.valid) {
    throw new ClinicalRuleServiceError(
      400,
      "Invalid clinical ruleset",
      collectionValidation.issues,
    )
  }

  const sourceRefsByKey = new Map(replacedRules.map(rule => [rule.ruleKey, rule.sourceRefs]))
  const inheritedSourceRefs = [...new Set(replacedRules.flatMap(rule => rule.sourceRefs))]
  const ruleVersion = `${preset.key}.v${preset.version}.${Date.now()}`
  return prisma.$transaction(async tx => {
    if (replacedRules.length) {
      await tx.clinicalPresetRule.deleteMany({
        where: {
          presetId: preset.id,
          ruleKey: { in: replacedRules.map(rule => rule.ruleKey) },
        },
      })
    }
    const created = await Promise.all(replacementRules.map(rule => (
      tx.clinicalPresetRule.create({
        data: {
          presetId: preset.id,
          ruleKey: rule.ruleKey,
          ruleVersion,
          payload: rule.payload as Prisma.InputJsonValue,
          sourceRefs: (sourceRefsByKey.get(rule.ruleKey) ?? inheritedSourceRefs) as Prisma.InputJsonValue,
        },
      })
    )))
    return created
  })
}

export async function deleteClinicalRulesetRule(input: {
  actor: AuthUser
  presetId: string
  ruleKey: string
}) {
  if (isLegacyEquipmentRule({ ruleKey: input.ruleKey })) {
    throw new ClinicalRuleServiceError(400, FIXED_EQUIPMENT_RULE_REJECTION_MESSAGE)
  }
  await requireEditablePreset(input.actor, input.presetId)
  await prisma.clinicalPresetRule.deleteMany({
    where: {
      presetId: input.presetId,
      ruleKey: input.ruleKey,
    },
  })
}

export async function publishClinicalRuleset(actor: AuthUser, presetId: string) {
  const preset = await requireEditablePreset(actor, presetId)
  const rules = editableRules(preset.rules)
  if (!rules.length) {
    throw new ClinicalRuleServiceError(409, "An empty ruleset cannot be published")
  }
  const collectionValidation = validateClinicalRuleCollectionForPublication(
    rules.map(rule => mapPresetRule(rule)),
  )
  if (!collectionValidation.valid) {
    throw new ClinicalRuleServiceError(
      409,
      "Ruleset cannot be published",
      collectionValidation.issues,
    )
  }
  return prisma.clinicalPreset.update({
    where: { id: preset.id },
    data: {
      status: "PUBLISHED",
      publishedById: actor.id,
      publishedAt: new Date(),
    },
  })
}

export async function selectClinicalRuleset(input: {
  actor: AuthUser
  scope: ClinicalPresetScope
  clinicalMode: ClinicalRuleMode
  presetId: string
  institutionId?: string | null
}) {
  const preset = await requirePreset(input.presetId)
  if (preset.status !== "PUBLISHED") {
    throw new ClinicalRuleServiceError(409, "Only published rulesets can be selected")
  }
  if (preset.scope !== input.scope || preset.clinicalMode !== input.clinicalMode) {
    throw new ClinicalRuleServiceError(400, "Ruleset scope or mode does not match the selection")
  }

  const ownerInstitutionId = input.scope === "INSTITUTION"
    ? input.institutionId ?? input.actor.institutionId
    : null
  const ownerUserId = input.scope === "USER" ? input.actor.id : null
  assertScopeOwner({
    actor: input.actor,
    scope: input.scope,
    ownerInstitutionId,
    ownerUserId,
  })
  if (
    input.scope === "INSTITUTION"
    && preset.ownerInstitutionId !== ownerInstitutionId
  ) {
    throw new ClinicalRuleServiceError(403, "Institution ruleset ownership mismatch")
  }
  if (input.scope === "USER" && preset.ownerUserId !== input.actor.id) {
    throw new ClinicalRuleServiceError(403, "Personal ruleset ownership mismatch")
  }

  if (input.scope === "PLATFORM") {
    return prisma.platformClinicalPresetSelection.upsert({
      where: { clinicalMode: input.clinicalMode },
      create: {
        clinicalMode: input.clinicalMode,
        presetId: preset.id,
        selectedById: input.actor.id,
      },
      update: {
        presetId: preset.id,
        selectedById: input.actor.id,
        selectedAt: new Date(),
      },
    })
  }
  if (input.scope === "INSTITUTION") {
    return prisma.institutionClinicalPresetSelection.upsert({
      where: {
        institutionId_clinicalMode: {
          institutionId: ownerInstitutionId!,
          clinicalMode: input.clinicalMode,
        },
      },
      create: {
        institutionId: ownerInstitutionId!,
        clinicalMode: input.clinicalMode,
        presetId: preset.id,
        selectedById: input.actor.id,
      },
      update: {
        presetId: preset.id,
        selectedById: input.actor.id,
        selectedAt: new Date(),
      },
    })
  }
  return prisma.userClinicalPresetSelection.upsert({
    where: {
      userId_clinicalMode: {
        userId: input.actor.id,
        clinicalMode: input.clinicalMode,
      },
    },
    create: {
      userId: input.actor.id,
      clinicalMode: input.clinicalMode,
      presetId: preset.id,
    },
    update: {
      presetId: preset.id,
      selectedAt: new Date(),
    },
  })
}

export async function clearClinicalRulesetSelection(input: {
  actor: AuthUser
  scope: ClinicalPresetScope
  clinicalMode: ClinicalRuleMode
  institutionId?: string | null
}) {
  if (input.scope === "PLATFORM") {
    assertScopeOwner({
      actor: input.actor,
      scope: "PLATFORM",
      ownerInstitutionId: null,
      ownerUserId: null,
    })
    return prisma.platformClinicalPresetSelection.deleteMany({
      where: { clinicalMode: input.clinicalMode },
    })
  }
  if (input.scope === "INSTITUTION") {
    const institutionId = input.institutionId ?? input.actor.institutionId
    assertScopeOwner({
      actor: input.actor,
      scope: "INSTITUTION",
      ownerInstitutionId: institutionId,
      ownerUserId: null,
    })
    return prisma.institutionClinicalPresetSelection.deleteMany({
      where: {
        institutionId: institutionId!,
        clinicalMode: input.clinicalMode,
      },
    })
  }
  return prisma.userClinicalPresetSelection.deleteMany({
    where: {
      userId: input.actor.id,
      clinicalMode: input.clinicalMode,
    },
  })
}

export class ClinicalRuleServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues?: unknown,
  ) {
    super(message)
    this.name = "ClinicalRuleServiceError"
  }
}
