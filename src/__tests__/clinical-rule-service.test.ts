import { beforeEach, describe, expect, it, vi } from "vitest"

const userSelectionFindMock = vi.fn()
const institutionSelectionFindMock = vi.fn()
const platformSelectionFindMock = vi.fn()
const platformSelectionUpsertMock = vi.fn()
const presetFindMock = vi.fn()
const presetFindManyMock = vi.fn()
const presetAggregateMock = vi.fn()
const presetCreateMock = vi.fn()
const presetUpdateManyMock = vi.fn()
const presetFindUniqueOrThrowMock = vi.fn()
const ruleCreateManyMock = vi.fn()
const ruleCreateMock = vi.fn()
const ruleDeleteManyMock = vi.fn()
const ruleUpsertMock = vi.fn()
const auditCreateMock = vi.fn()
const userSelectionDeleteMock = vi.fn()
const userSelectionUpsertMock = vi.fn()
const publicationCreateMock = vi.fn()
const publicationFindMock = vi.fn()
const institutionFindManyMock = vi.fn()
const transactionMock = vi.fn()
const verifyCurrentPasswordMock = vi.fn()

vi.mock("@/lib/credentials", () => ({
  verifyCurrentPassword: verifyCurrentPasswordMock,
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    userClinicalPresetSelection: {
      findUnique: userSelectionFindMock,
    },
    institutionClinicalPresetSelection: {
      findUnique: institutionSelectionFindMock,
    },
    platformClinicalPresetSelection: {
      findUnique: platformSelectionFindMock,
    },
    clinicalPreset: {
      findUnique: presetFindMock,
      findMany: presetFindManyMock,
      aggregate: presetAggregateMock,
    },
    clinicalRulesetPublicationEvidence: {
      findUnique: publicationFindMock,
    },
    institution: {
      findMany: institutionFindManyMock,
    },
    $transaction: transactionMock,
  },
}))

const hod = {
  id: "hod-1",
  role: "HEAD_OF_DEPT",
  accountKind: "CLINICAL" as const,
  preferredLocale: "bg" as const,
  institutionId: "inst-1",
  institutionName: "Hospital A",
  firstName: "Head",
  lastName: "One",
  title: null,
  jti: null,
  clientType: "WEB" as const,
}

const member = {
  ...hod,
  id: "member-1",
  role: "MEMBER",
}

const admin = {
  ...hod,
  id: "admin-1",
  role: "ADMIN",
  institutionId: null,
  institutionName: null,
}

function preset(input: {
  id: string
  scope: "PLATFORM" | "INSTITUTION" | "USER"
  mode?: "ADULT" | "PEDIATRIC"
}) {
  return {
    id: input.id,
    key: input.id.toUpperCase(),
    name: input.id,
    description: null,
    clinicalMode: input.mode ?? "ADULT",
    scope: input.scope,
    ownerInstitutionId: input.scope === "INSTITUTION" ? "inst-1" : null,
    ownerInstitution: input.scope === "INSTITUTION"
      ? { id: "inst-1", name: "Hospital A" }
      : null,
    ownerUserId: input.scope === "USER" ? "member-1" : null,
    ownerUser: null,
    copiedFromPresetId: null,
    copiedFromVersion: null,
    version: 1,
    status: "PUBLISHED",
    createdById: null,
    publishedById: null,
    publishedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    rules: [],
    overrides: [],
    platformSelections: [],
    institutionSelections: [],
    userSelections: [],
    copies: [],
    _count: { institutionSelections: 0 },
  }
}

function pediatricProfilePayload() {
  return {
    kind: "PEDIATRIC_DRUG_PROFILE" as const,
    medicationKey: "Atropine",
    labelEn: "Atropine",
    minimumAgeDays: 0,
    maximumAgeDaysExclusive: 18 * 365.2425,
    profile: {
      routes: ["IV"],
      defaultRoute: "IV",
      routeModes: {
        IV: {
          min: 0,
          max: 2,
          step: 0.1,
          unit: "mg",
          quickValues: [0.1, 0.2],
          doseCalc: { perKg: 0.01, basis: "TBW" as const, roundTo: 0.1 },
        },
      },
    },
  }
}

describe("clinical ruleset hierarchy", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    userSelectionFindMock.mockResolvedValue(null)
    institutionSelectionFindMock.mockResolvedValue(null)
    platformSelectionFindMock.mockResolvedValue(null)
    presetFindManyMock.mockResolvedValue([])
    institutionFindManyMock.mockResolvedValue([])
    presetAggregateMock.mockResolvedValue({ _max: { version: null } })
    verifyCurrentPasswordMock.mockResolvedValue(true)
    transactionMock.mockImplementation(async callback => callback({
      clinicalPreset: {
        create: presetCreateMock,
        updateMany: presetUpdateManyMock,
        findUniqueOrThrow: presetFindUniqueOrThrowMock,
      },
      clinicalRulesetPublicationEvidence: { create: publicationCreateMock },
      clinicalPresetRule: {
        create: ruleCreateMock,
        createMany: ruleCreateManyMock,
        deleteMany: ruleDeleteManyMock,
        upsert: ruleUpsertMock,
      },
      auditLog: { create: auditCreateMock },
      userClinicalPresetSelection: {
        findUnique: userSelectionFindMock,
        deleteMany: userSelectionDeleteMock,
        upsert: userSelectionUpsertMock,
      },
      platformClinicalPresetSelection: {
        findUnique: platformSelectionFindMock,
        upsert: platformSelectionUpsertMock,
      },
    }))
    presetCreateMock.mockResolvedValue({ id: "created-ruleset", key: "CREATED", version: 1 })
    presetUpdateManyMock.mockResolvedValue({ count: 1 })
    presetFindUniqueOrThrowMock.mockResolvedValue({ id: "published-ruleset" })
    publicationCreateMock.mockResolvedValue({})
    publicationFindMock.mockResolvedValue({ contentSha256: "content-sha", diffSha256: "diff-sha" })
    userSelectionUpsertMock.mockResolvedValue({ presetId: "personal-published" })
    platformSelectionUpsertMock.mockResolvedValue({ presetId: "platform-published" })
    auditCreateMock.mockResolvedValue({})
  })

  it("resolves personal then institution then platform within one mode", async () => {
    platformSelectionFindMock.mockResolvedValue({ preset: preset({ id: "platform", scope: "PLATFORM" }) })
    institutionSelectionFindMock.mockResolvedValue({ preset: preset({ id: "institution", scope: "INSTITUTION" }) })
    userSelectionFindMock.mockResolvedValue({ preset: preset({ id: "personal", scope: "USER" }) })
    const { effectiveClinicalRulesForUser } = await import("@/lib/clinical-rules/service")

    await expect(effectiveClinicalRulesForUser(member, "ADULT")).resolves.toMatchObject({
      presetId: "personal",
      scope: "USER",
    })

    userSelectionFindMock.mockResolvedValue(null)
    await expect(effectiveClinicalRulesForUser(member, "ADULT")).resolves.toMatchObject({
      presetId: "institution",
      scope: "INSTITUTION",
    })

    institutionSelectionFindMock.mockResolvedValue(null)
    await expect(effectiveClinicalRulesForUser(member, "ADULT")).resolves.toMatchObject({
      presetId: "platform",
      scope: "PLATFORM",
    })
  })

  it("never falls back across adult and pediatric modes", async () => {
    platformSelectionFindMock.mockResolvedValue({
      preset: preset({ id: "adult-platform", scope: "PLATFORM", mode: "ADULT" }),
    })
    const { effectiveClinicalRulesForUser } = await import("@/lib/clinical-rules/service")
    await expect(effectiveClinicalRulesForUser(member, "PEDIATRIC")).resolves.toMatchObject({
      presetId: null,
      rules: [],
    })
  })

  it("atomically replaces every band and retires legacy rows for one pediatric drug", async () => {
    const draft = {
      ...preset({ id: "pediatric-draft", scope: "PLATFORM", mode: "PEDIATRIC" }),
      status: "DRAFT",
      rules: [{
        id: "legacy-policy",
        presetId: "pediatric-draft",
        ruleKey: "PEDIATRIC_DRUG_POLICY:ATROPINE",
        ruleVersion: "1",
        payload: {
          kind: "PEDIATRIC_DRUG_POLICY",
          medicationKey: "Atropine",
          labelEn: "Atropine",
          disposition: "MANUAL_NO_PROFILE",
          reviewStatus: "APPROVED",
          rationaleEn: "Legacy",
        },
        sourceRefs: ["https://example.test/source"],
      }],
    }
    presetFindMock.mockResolvedValue(draft)
    ruleCreateMock.mockImplementation(async ({ data }) => ({ id: data.ruleKey, ...data }))
    const { replacePediatricDrugProfiles } = await import("@/lib/clinical-rules/service")

    const result = await replacePediatricDrugProfiles({
      actor: admin,
      presetId: draft.id,
      medicationKey: "Atropine",
      profiles: [{
        kind: "PEDIATRIC_DRUG_PROFILE",
        medicationKey: "Atropine",
        labelEn: "Atropine",
        availability: "MANUAL",
        minimumAgeDays: 0,
        maximumAgeDaysExclusive: 18 * 365.2425,
        profile: {
          mode: "dose",
          min: 0,
          max: 3,
          step: 0.1,
          quickValues: [0.1, 0.2, 0.5],
          unit: "mg",
          routes: ["IV"],
          defaultRoute: "IV",
          weightBasis: "TBW",
        },
      }],
    })

    expect(ruleDeleteManyMock).toHaveBeenCalledWith({
      where: {
        presetId: draft.id,
        ruleKey: { in: ["PEDIATRIC_DRUG_POLICY:ATROPINE"] },
      },
    })
    expect(ruleCreateMock).toHaveBeenCalledTimes(1)
    expect(ruleCreateMock.mock.calls[0]?.[0].data.sourceRefs).toEqual([
      "https://example.test/source",
    ])
    expect(result).toHaveLength(1)
    expect(auditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "CLINICAL_RULESET_PEDIATRIC_DRUG_REPLACE",
        entityId: draft.id,
        detail: expect.objectContaining({ replacedRuleCount: 1, createdRuleCount: 1 }),
      }),
    })
    const auditJson = JSON.stringify(auditCreateMock.mock.calls)
    expect(auditJson).not.toContain("Atropine")
    expect(auditJson).not.toContain("medicationKey")
  })

  it("keeps platform rulesets administrator-only", async () => {
    const { createClinicalRuleset } = await import("@/lib/clinical-rules/service")
    await expect(createClinicalRuleset({
      actor: hod,
      scope: "PLATFORM",
      clinicalMode: "ADULT",
      key: "PLATFORM",
      name: "Platform",
    })).rejects.toMatchObject({ status: 403 })
    expect(presetAggregateMock).not.toHaveBeenCalled()
  })

  it("serves the exact bundled v2 selection for each runtime mode", async () => {
    const { computeBundledBaselineArtifacts } = await import(
      "@/lib/clinical-rules/bundled-baseline-contract"
    )
    const artifacts = computeBundledBaselineArtifacts()
    platformSelectionFindMock.mockImplementation(async ({ where }) => {
      const artifact = artifacts.find(item => item.identity.clinicalMode === where.clinicalMode)
      if (!artifact) return null
      return {
        preset: {
          id: artifact.identity.presetId,
          name: artifact.name,
          version: artifact.identity.presetVersion,
          status: "PUBLISHED",
          clinicalMode: artifact.identity.clinicalMode,
          scope: "PLATFORM",
          rules: artifact.rules.map((rule, index) => ({
            id: `${artifact.identity.presetId}:${index}`,
            ...rule,
          })),
        },
      }
    })
    const { effectiveClinicalRulesForUser } = await import("@/lib/clinical-rules/service")

    const [adult, pediatric] = await Promise.all([
      effectiveClinicalRulesForUser(member, "ADULT"),
      effectiveClinicalRulesForUser(member, "PEDIATRIC"),
    ])

    expect(adult).toMatchObject({ presetId: "lospor-adults-v2", presetVersion: 2, scope: "PLATFORM" })
    expect(pediatric).toMatchObject({ presetId: "lospor-pediatrics-v2", presetVersion: 2, scope: "PLATFORM" })
    expect(adult.rules.length).toBeGreaterThan(0)
    expect(pediatric.rules.length).toBeGreaterThan(0)
    expect(adult.rules.every(rule => rule.presetId === "lospor-adults-v2")).toBe(true)
    expect(pediatric.rules.every(rule => rule.presetId === "lospor-pediatrics-v2")).toBe(true)
  })

  it("clears technical attribution when an administrator changes a platform selection", async () => {
    const published = preset({ id: "platform-published", scope: "PLATFORM" })
    presetFindMock.mockResolvedValue(published)
    platformSelectionFindMock.mockResolvedValue({
      presetId: "lospor-adults-v2",
      selectedByTechnicalPrincipalId: "lospor-release:1.2.0",
    })
    const { selectClinicalRuleset } = await import("@/lib/clinical-rules/service")

    await selectClinicalRuleset({
      actor: admin,
      scope: "PLATFORM",
      clinicalMode: "ADULT",
      presetId: published.id,
    })

    expect(platformSelectionUpsertMock).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        selectedById: admin.id,
        selectedByTechnicalPrincipalId: null,
      }),
    }))
  })

  it("saves a draft rule and its privacy-safe audit evidence atomically", async () => {
    const draft = {
      ...preset({ id: "pediatric-draft", scope: "PLATFORM", mode: "PEDIATRIC" }),
      status: "DRAFT",
      rules: [],
    }
    presetFindMock.mockResolvedValue(draft)
    ruleUpsertMock.mockResolvedValue({
      id: "rule-1",
      presetId: draft.id,
      ruleKey: "PEDIATRIC_DRUG_PROFILE:ATROPINE:0-6575",
    })
    const { upsertClinicalRulesetRule } = await import("@/lib/clinical-rules/service")
    await upsertClinicalRulesetRule({
      actor: admin,
      presetId: draft.id,
      payload: {
        kind: "PEDIATRIC_DRUG_PROFILE",
        medicationKey: "Atropine",
        labelEn: "Atropine",
        minimumAgeDays: 0,
        maximumAgeDaysExclusive: 18 * 365.2425,
        profile: {
          routes: ["IV"],
          defaultRoute: "IV",
          routeModes: {
            IV: {
              min: 0,
              max: 2,
              step: 0.1,
              unit: "mg",
              quickValues: [0.1, 0.2],
              doseCalc: { perKg: 0.01, basis: "TBW", roundTo: 0.1 },
            },
          },
        },
      },
    })

    expect(auditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "CLINICAL_RULESET_RULE_UPSERT",
        entityId: "rule-1",
        detail: expect.objectContaining({
          presetId: draft.id,
          transition: "CREATE",
          changedFields: ["payload", "ruleVersion"],
        }),
      }),
    })
    expect(JSON.stringify(auditCreateMock.mock.calls)).not.toContain("Atropine")
  })

  it("deletes a draft rule and writes one audit row only when a row changed", async () => {
    const draft = {
      ...preset({ id: "adult-draft", scope: "PLATFORM" }),
      status: "DRAFT",
      rules: [],
    }
    presetFindMock.mockResolvedValue(draft)
    ruleDeleteManyMock.mockResolvedValue({ count: 1 })
    const { deleteClinicalRulesetRule } = await import("@/lib/clinical-rules/service")
    await deleteClinicalRulesetRule({ actor: admin, presetId: draft.id, ruleKey: "ADULT_DRUG_PROFILE:TEST" })
    expect(auditCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "CLINICAL_RULESET_RULE_DELETE",
        detail: expect.objectContaining({ deletedRuleCount: 1, changedFields: ["rules"] }),
      }),
    })

    auditCreateMock.mockClear()
    ruleDeleteManyMock.mockClear()
    presetFindMock.mockResolvedValue(draft)
    ruleDeleteManyMock.mockResolvedValue({ count: 0 })
    await deleteClinicalRulesetRule({ actor: admin, presetId: draft.id, ruleKey: "ADULT_DRUG_PROFILE:MISSING" })
    expect(auditCreateMock).not.toHaveBeenCalled()
  })

  it("clears a personal selection and audits the previous immutable preset ID", async () => {
    userSelectionFindMock.mockResolvedValue({ presetId: "personal-v1" })
    userSelectionDeleteMock.mockResolvedValue({ count: 1 })
    const { clearClinicalRulesetSelection } = await import("@/lib/clinical-rules/service")
    await clearClinicalRulesetSelection({ actor: member, scope: "USER", clinicalMode: "ADULT" })
    expect(auditCreateMock).toHaveBeenCalledWith({
      data: {
        userId: "member-1",
        action: "CLINICAL_RULESET_SELECTION_CLEAR",
        entityId: "member-1",
        detail: { scope: "USER", clinicalMode: "ADULT", previousPresetId: "personal-v1" },
      },
    })
  })

  // HAUD_ROLLBACK:clinical-rules-api-governance
  it("propagates audit failure from ruleset creation", async () => {
    auditCreateMock.mockRejectedValueOnce(new Error("audit unavailable"))
    const { createClinicalRuleset } = await import("@/lib/clinical-rules/service")

    await expect(createClinicalRuleset({
      actor: member,
      scope: "USER",
      clinicalMode: "ADULT",
      key: "MY_RULES",
      name: "My rules",
    })).rejects.toThrow("audit unavailable")
  })

  it("propagates audit failure from rule upsert and deletion", async () => {
    const draft = {
      ...preset({ id: "pediatric-draft", scope: "PLATFORM", mode: "PEDIATRIC" }),
      status: "DRAFT",
      rules: [],
    }
    presetFindMock.mockResolvedValue(draft)
    ruleUpsertMock.mockResolvedValue({ id: "rule-1", presetId: draft.id })
    auditCreateMock.mockRejectedValueOnce(new Error("upsert audit unavailable"))
    const { deleteClinicalRulesetRule, upsertClinicalRulesetRule } = await import("@/lib/clinical-rules/service")

    await expect(upsertClinicalRulesetRule({
      actor: admin,
      presetId: draft.id,
      payload: pediatricProfilePayload(),
    })).rejects.toThrow("upsert audit unavailable")

    presetFindMock.mockResolvedValue(draft)
    ruleDeleteManyMock.mockResolvedValue({ count: 1 })
    auditCreateMock.mockRejectedValueOnce(new Error("delete audit unavailable"))
    await expect(deleteClinicalRulesetRule({
      actor: admin,
      presetId: draft.id,
      ruleKey: "PEDIATRIC_DRUG_PROFILE:ATROPINE:0-6575",
    })).rejects.toThrow("delete audit unavailable")
  })

  it("propagates audit failure from atomic pediatric drug replacement", async () => {
    const draft = {
      ...preset({ id: "pediatric-draft", scope: "PLATFORM", mode: "PEDIATRIC" }),
      status: "DRAFT",
      rules: [],
    }
    presetFindMock.mockResolvedValue(draft)
    ruleCreateMock.mockImplementation(async ({ data }) => ({ id: data.ruleKey, ...data }))
    auditCreateMock.mockRejectedValueOnce(new Error("replace audit unavailable"))
    const { replacePediatricDrugProfiles } = await import("@/lib/clinical-rules/service")

    await expect(replacePediatricDrugProfiles({
      actor: admin,
      presetId: draft.id,
      medicationKey: "Atropine",
      profiles: [{
        kind: "PEDIATRIC_DRUG_PROFILE",
        medicationKey: "Atropine",
        labelEn: "Atropine",
        availability: "MANUAL",
        minimumAgeDays: 0,
        maximumAgeDaysExclusive: 18 * 365.2425,
        profile: {
          mode: "dose",
          min: 0,
          max: 3,
          step: 0.1,
          quickValues: [0.1, 0.2, 0.5],
          unit: "mg",
          routes: ["IV"],
          defaultRoute: "IV",
          weightBasis: "TBW",
        },
      }],
    })).rejects.toThrow("replace audit unavailable")
  })

  it("propagates audit failure from publication and selection governance", async () => {
    const payload = pediatricProfilePayload()
    const draft = {
      ...preset({ id: "personal-draft", scope: "USER", mode: "PEDIATRIC" }),
      status: "DRAFT",
      rules: [{
        id: "rule-1",
        presetId: "personal-draft",
        ruleKey: "PEDIATRIC_DRUG_PROFILE:ATROPINE:0-6575",
        ruleVersion: "PERSONAL.v1",
        payload,
        sourceRefs: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }],
    }
    presetFindMock.mockResolvedValue(draft)
    auditCreateMock.mockRejectedValueOnce(new Error("publish audit unavailable"))
    const { publishClinicalRuleset, selectClinicalRuleset } = await import("@/lib/clinical-rules/service")

    await expect(publishClinicalRuleset(member, draft.id)).rejects.toThrow("publish audit unavailable")

    presetFindMock.mockResolvedValue({
      ...preset({ id: "personal-published", scope: "USER", mode: "PEDIATRIC" }),
      ownerUserId: member.id,
    })
    userSelectionFindMock.mockResolvedValue({ presetId: "previous-personal" })
    auditCreateMock.mockRejectedValueOnce(new Error("select audit unavailable"))
    await expect(selectClinicalRuleset({
      actor: member,
      scope: "USER",
      clinicalMode: "PEDIATRIC",
      presetId: "personal-published",
    })).rejects.toThrow("select audit unavailable")
  })

  it("propagates audit failure from selection clearing", async () => {
    userSelectionFindMock.mockResolvedValue({ presetId: "personal-v1" })
    userSelectionDeleteMock.mockResolvedValue({ count: 1 })
    auditCreateMock.mockRejectedValueOnce(new Error("audit unavailable"))
    const { clearClinicalRulesetSelection } = await import("@/lib/clinical-rules/service")

    await expect(clearClinicalRulesetSelection({
      actor: member,
      scope: "USER",
      clinicalMode: "ADULT",
    })).rejects.toThrow("audit unavailable")
  })

  it.each([
    [admin, "INSTITUTION"],
    [hod, "PLATFORM"],
    [member, "INSTITUTION"],
    [member, "PLATFORM"],
  ] as const)("rejects %s managing %s before database access", async (actor, scope) => {
    const { loadClinicalRulesWorkbench } = await import("@/lib/clinical-rules/service")
    await expect(loadClinicalRulesWorkbench(actor, scope, "ADULT")).rejects.toMatchObject({
      status: 403,
    })
    expect(presetFindManyMock).not.toHaveBeenCalled()
  })

  it.each([
    [admin, "PLATFORM", ["PLATFORM", "USER"]],
    [hod, "INSTITUTION", ["INSTITUTION", "USER"]],
    [member, "USER", ["USER"]],
  ] as const)("defaults %s to its tier scope", async (actor, activeScope, allowedScopes) => {
    const { loadClinicalRulesWorkbench } = await import("@/lib/clinical-rules/service")
    await expect(loadClinicalRulesWorkbench(actor, null, "ADULT")).resolves.toMatchObject({
      management: {
        activeScope,
        defaultScope: activeScope,
        allowedScopes: [...allowedScopes],
      },
    })
  })

  it("does not copy legacy equipment rows into a member-owned draft", async () => {
    const source = {
      ...preset({ id: "platform", scope: "PLATFORM" }),
      rules: [{
        id: "rule-1",
        presetId: "platform",
        ruleKey: "ADULT_EQUIPMENT_PROFILE:LOSPOR_ADULT_EQUIPMENT",
        ruleVersion: "platform.v1",
        payload: {
          kind: "ADULT_EQUIPMENT_PROFILE",
          itemKey: "LOSPOR_ADULT_EQUIPMENT",
          labelEn: "Adult equipment",
          policyVersion: "LOSPOR_ADULT_EQUIPMENT_V1",
          tidalVolumeMinMlPerKgIbw: 6,
          tidalVolumeMaxMlPerKgIbw: 8,
          standardPeepCmH2o: 5,
          obesityPeepCmH2o: 8,
          obesityBmiThreshold: 30,
          severeObesityPeepCmH2o: 10,
          severeObesityBmiThreshold: 40,
        },
        sourceRefs: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }],
    }
    presetFindMock.mockResolvedValue(source)
    presetCreateMock.mockResolvedValue({
      id: "personal-copy",
      key: "MY_ADULT_RULES",
      version: 1,
    })
    const { createClinicalRuleset } = await import("@/lib/clinical-rules/service")
    await expect(createClinicalRuleset({
      actor: member,
      scope: "USER",
      clinicalMode: "ADULT",
      key: "MY_ADULT_RULES",
      name: "My adult rules",
      copyFromPresetId: "platform",
    })).resolves.toMatchObject({ id: "personal-copy" })
    expect(ruleCreateManyMock).not.toHaveBeenCalled()
  })

  it("rejects stale equipment writes before loading the preset", async () => {
    const { upsertClinicalRulesetRule } = await import("@/lib/clinical-rules/service")
    await expect(upsertClinicalRulesetRule({
      actor: member,
      presetId: "personal-copy",
      payload: {
        kind: "PEDIATRIC_EQUIPMENT",
        itemKey: "ETT",
      },
    })).rejects.toMatchObject({
      status: 400,
      message: "Equipment suggestions are globally fixed application guidance and cannot be edited through clinical rulesets.",
    })
    expect(presetFindMock).not.toHaveBeenCalled()
  })

  it("blocks publication when one drug has overlapping pediatric age profiles", async () => {
    const profile = (minimumAgeDays: number, maximumAgeDaysExclusive: number) => ({
      kind: "PEDIATRIC_DRUG_PROFILE" as const,
      medicationKey: "ATROPINE",
      labelEn: "Atropine",
      minimumAgeDays,
      maximumAgeDaysExclusive,
      profile: {
        routes: ["IV"],
        defaultRoute: "IV",
        routeModes: {
          IV: {
            min: 0,
            max: 2,
            step: 0.1,
            unit: "mg",
            quickValues: [0.1, 0.2, 0.3],
            doseCalc: { perKg: 0.01, basis: "TBW", roundTo: 0.1 },
          },
        },
      },
    })
    const rule = (id: string, key: string, payload: ReturnType<typeof profile>) => ({
      id,
      presetId: "pediatric-draft",
      ruleKey: key,
      ruleVersion: `${key}.1`,
      payload,
      sourceRefs: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    presetFindMock.mockResolvedValue({
      ...preset({ id: "pediatric-draft", scope: "USER", mode: "PEDIATRIC" }),
      status: "DRAFT",
      rules: [
        rule("profile-1", "PEDIATRIC_DRUG_PROFILE:ATROPINE:0-3650", profile(0, 3650)),
        rule("profile-2", "PEDIATRIC_DRUG_PROFILE:ATROPINE:3000-6575", profile(3000, 6575)),
      ],
    })
    const { publishClinicalRuleset } = await import("@/lib/clinical-rules/service")

    await expect(publishClinicalRuleset(member, "pediatric-draft")).rejects.toMatchObject({
      status: 409,
      message: "Ruleset cannot be published",
      issues: [expect.objectContaining({ field: "minimumAgeDays" })],
    })
  })

  it("blocks publication while a pediatric policy remains pending", async () => {
    presetFindMock.mockResolvedValue({
      ...preset({ id: "pediatric-draft", scope: "USER", mode: "PEDIATRIC" }),
      status: "DRAFT",
      rules: [{
        id: "policy-1",
        presetId: "pediatric-draft",
        ruleKey: "PEDIATRIC_DRUG_POLICY:PROPOFOL",
        ruleVersion: "PEDIATRIC.v1",
        payload: {
          kind: "PEDIATRIC_DRUG_POLICY",
          medicationKey: "Propofol",
          labelEn: "Propofol",
          category: "Intravenous hypnotics",
          disposition: "PENDING_RESEARCH",
          reviewStatus: "PENDING",
          rationaleEn: "Evidence review is incomplete.",
        },
        sourceRefs: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      }],
    })
    const { publishClinicalRuleset } = await import("@/lib/clinical-rules/service")

    await expect(publishClinicalRuleset(member, "pediatric-draft")).rejects.toMatchObject({
      status: 409,
      message: "Ruleset cannot be published",
      issues: expect.arrayContaining([
        expect.objectContaining({ field: "reviewStatus" }),
        expect.objectContaining({ field: "disposition" }),
      ]),
    })
  })
})
