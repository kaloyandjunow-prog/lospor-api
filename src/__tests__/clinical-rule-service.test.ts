import { beforeEach, describe, expect, it, vi } from "vitest"

const userSelectionFindMock = vi.fn()
const institutionSelectionFindMock = vi.fn()
const platformSelectionFindMock = vi.fn()
const presetFindMock = vi.fn()
const presetFindManyMock = vi.fn()
const presetAggregateMock = vi.fn()
const presetCreateMock = vi.fn()
const ruleCreateManyMock = vi.fn()
const ruleCreateMock = vi.fn()
const ruleDeleteManyMock = vi.fn()
const institutionFindManyMock = vi.fn()
const transactionMock = vi.fn()

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
    institution: {
      findMany: institutionFindManyMock,
    },
    $transaction: transactionMock,
  },
}))

const hod = {
  id: "hod-1",
  role: "HEAD_OF_DEPT",
  institutionId: "inst-1",
  institutionName: "Hospital A",
  firstName: "Head",
  lastName: "One",
  title: null,
  jti: null,
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

describe("clinical ruleset hierarchy", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    userSelectionFindMock.mockResolvedValue(null)
    institutionSelectionFindMock.mockResolvedValue(null)
    platformSelectionFindMock.mockResolvedValue(null)
    presetFindManyMock.mockResolvedValue([])
    institutionFindManyMock.mockResolvedValue([])
    presetAggregateMock.mockResolvedValue({ _max: { version: null } })
    transactionMock.mockImplementation(async callback => callback({
      clinicalPreset: { create: presetCreateMock },
      clinicalPresetRule: {
        create: ruleCreateMock,
        createMany: ruleCreateManyMock,
        deleteMany: ruleDeleteManyMock,
      },
    }))
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
