import { describe, expect, it, vi } from "vitest"
import {
  BundledBaselineProvisionError,
  provisionBundledClinicalBaselines,
} from "./bundled-baseline-provisioner"

type Row = Record<string, unknown>
type StoredPreset = Row & { rules: Row[]; publicationEvidence: Row | null }

type FakeState = {
  principals: Row[]
  presets: StoredPreset[]
  selections: Row[]
  audits: Row[]
  accountCount: number
  sessionCount: number
}

/** The subset of a Prisma `where` the provisioners use: equality, `in`, `is`, `OR`. */
function matches(row: unknown, where: unknown): boolean {
  if (!where || typeof where !== "object") return true
  const record = (row ?? {}) as Row
  const filter = where as Row
  if (Array.isArray(filter.OR)) return filter.OR.some(item => matches(row, item))
  return Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if ("in" in value) return ((value as { in: unknown[] }).in).includes(record[key])
      if ("is" in value) return record[key] != null && matches(record[key], (value as { is: unknown }).is)
      return matches(record[key], value)
    }
    return record[key] === value
  })
}

class InMemoryPrisma {
  state: FakeState = {
    principals: [],
    presets: [],
    selections: [],
    audits: [],
    accountCount: 0,
    sessionCount: 0,
  }

  writes: string[] = []
  auditFindQueries: unknown[] = []
  transactionAttempts = 0
  serializeFirstAttempt = false
  failEvidenceNumber: number | null = null
  private evidenceCreates = 0

  private transactionClient() {
    return {
      technicalPrincipal: {
        findMany: async ({ where }: { where?: unknown } = {}) => this.state.principals.filter(row => matches(row, where)),
        create: async ({ data }: { data: Row }) => {
          this.writes.push("technicalPrincipal.create")
          this.state.principals.push({ ...data })
          return data
        },
      },
      user: { count: async () => this.state.accountCount },
      authSession: { count: async () => this.state.sessionCount },
      clinicalPreset: {
        findMany: async ({ where }: { where?: unknown } = {}) => this.state.presets.filter(row => matches(row, where)),
        create: async ({ data }: { data: Row }) => {
          this.writes.push(`clinicalPreset.create:${String(data.status)}`)
          const nestedRules = ((data.rules as Row | undefined)?.create ?? []) as Row[]
          const createdAt = data.createdAt as Date
          const preset: StoredPreset = {
            ownerInstitutionId: null,
            ownerUserId: null,
            copiedFromPresetId: null,
            copiedFromVersion: null,
            createdById: null,
            publishedById: null,
            publishedByTechnicalPrincipalId: null,
            publishedAt: null,
            updatedAt: createdAt,
            ...data,
            rules: nestedRules.slice().reverse().map((rule, index) => ({
              id: `${String(data.id)}:rule:${index}`,
              presetId: data.id,
              ...rule,
            })),
            publicationEvidence: null,
          }
          this.state.presets.push(preset)
          return preset
        },
        update: async ({ where, data }: { where: { id: string }; data: Row }) => {
          this.writes.push(`clinicalPreset.update:${String(data.status)}`)
          const preset = this.state.presets.find(item => item.id === where.id)
          if (!preset) throw new Error("missing fake preset")
          Object.assign(preset, data)
          return preset
        },
      },
      clinicalRulesetPublicationEvidence: {
        create: async ({ data }: { data: Row }) => {
          this.evidenceCreates += 1
          this.writes.push("publicationEvidence.create")
          if (this.failEvidenceNumber === this.evidenceCreates) {
            throw new Error("simulated publication evidence failure")
          }
          const evidence = { confirmedById: null, ...data }
          const preset = this.state.presets.find(item => item.id === data.presetId)
          if (!preset) throw new Error("missing fake evidence preset")
          preset.publicationEvidence = evidence
          return evidence
        },
      },
      platformClinicalPresetSelection: {
        findMany: async ({ where }: { where?: unknown } = {}) => this.state.selections.filter(row => matches(row, where)),
        update: async ({ where, data }: { where: { clinicalMode: string }; data: Row }) => {
          this.writes.push("platformSelection.update")
          const selection = this.state.selections.find(item => item.clinicalMode === where.clinicalMode)
          if (!selection) throw new Error("missing fake selection")
          Object.assign(selection, data)
          return selection
        },
        create: async ({ data }: { data: Row }) => {
          this.writes.push("platformSelection.create")
          const selection = {
            selectedById: null,
            updatedAt: data.selectedAt,
            ...data,
          }
          this.state.selections.push(selection)
          return selection
        },
      },
      auditLog: {
        findMany: async ({ where }: { where: unknown }) => {
          this.auditFindQueries.push(where)
          return this.state.audits.filter(row => matches(row, where))
        },
        create: async ({ data }: { data: Row }) => {
          this.writes.push("auditLog.create")
          this.state.audits.push({ ...data })
          return data
        },
      },
    }
  }

  async $transaction<T>(
    operation: (tx: never) => Promise<T>,
    options: { isolationLevel: string; maxWait: number; timeout: number },
  ): Promise<T> {
    this.transactionAttempts += 1
    expect(options).toEqual({ isolationLevel: "Serializable", maxWait: 10_000, timeout: 120_000 })
    if (this.serializeFirstAttempt && this.transactionAttempts === 1) {
      throw Object.assign(new Error("serialization conflict"), { code: "P2034" })
    }
    const snapshot = structuredClone(this.state)
    try {
      return await operation(this.transactionClient() as never)
    } catch (error) {
      this.state = snapshot
      throw error
    }
  }
}

describe("bundled clinical baseline provisioner", () => {
  // HAUD_ROLLBACK:bundled-clinical-baseline-provision
  it("installs DRAFT -> evidence -> PUBLISHED and verifies exact state before commit", async () => {
    const db = new InMemoryPrisma()
    const result = await provisionBundledClinicalBaselines(db as never, {
      installedAt: new Date("2026-08-23T12:00:00.000Z"),
    })

    expect(result).toMatchObject({
      outcome: "installed",
      releaseVersion: "1.2.0",
      technicalPrincipalId: "lospor-release:1.2.0",
      baselines: [
        { clinicalMode: "ADULT", presetVersion: 2, ruleCount: 251 },
        { clinicalMode: "PEDIATRIC", presetVersion: 2, ruleCount: 335 },
      ],
      v3: {
        outcome: "installed",
        releaseVersion: "9.15.0",
        baselines: [
          { clinicalMode: "ADULT", presetId: "lospor-adults-v3", presetVersion: 3, ruleCount: 267, selected: true },
          { clinicalMode: "PEDIATRIC", presetId: "lospor-pediatrics-v3", presetVersion: 3, ruleCount: 367, selected: true },
        ],
      },
    })
    // A fresh appliance gets both releases and ends on v3.
    expect(db.state.principals.map(row => row.id)).toEqual(["lospor-release:1.2.0", "lospor-release:9.15.0"])
    expect(db.state.presets).toHaveLength(4)
    expect(db.state.selections.map(row => row.presetId)).toEqual(["lospor-adults-v3", "lospor-pediatrics-v3"])
    expect(db.state.audits).toHaveLength(4)
    expect(db.writes).toEqual([
      "technicalPrincipal.create",
      "clinicalPreset.create:DRAFT",
      "publicationEvidence.create",
      "clinicalPreset.update:PUBLISHED",
      "platformSelection.create",
      "auditLog.create",
      "clinicalPreset.create:DRAFT",
      "publicationEvidence.create",
      "clinicalPreset.update:PUBLISHED",
      "platformSelection.create",
      "auditLog.create",
      "technicalPrincipal.create",
      "clinicalPreset.create:DRAFT",
      "publicationEvidence.create",
      "clinicalPreset.update:PUBLISHED",
      "platformSelection.update",
      "auditLog.create",
      "clinicalPreset.create:DRAFT",
      "publicationEvidence.create",
      "clinicalPreset.update:PUBLISHED",
      "platformSelection.update",
      "auditLog.create",
    ])
  })

  it("verifies an exact retry without writing or changing timestamps", async () => {
    const db = new InMemoryPrisma()
    const installedAt = new Date("2026-08-23T12:00:00.000Z")
    await provisionBundledClinicalBaselines(db as never, { installedAt })
    db.writes.length = 0

    const retry = await provisionBundledClinicalBaselines(db as never, {
      installedAt: new Date("2030-01-01T00:00:00.000Z"),
    })

    expect(retry.outcome).toBe("verified")
    expect(db.writes).toEqual([])
    expect(db.state.principals[0]?.createdAt).toEqual(installedAt)
  })

  it("fails closed on partial state, a governed selection conflict, and content drift", async () => {
    const partial = new InMemoryPrisma()
    partial.state.principals.push({
      id: "lospor-release:1.2.0",
      kind: "RELEASE",
      displayName: "LOSPOR 1.2.0",
      releaseVersion: "1.2.0",
      createdAt: new Date(),
    })
    await expect(provisionBundledClinicalBaselines(partial as never)).rejects.toMatchObject({
      code: "BUNDLED_BASELINE_PARTIAL_STATE",
    })
    expect(partial.writes).toEqual([])

    const conflict = new InMemoryPrisma()
    conflict.state.selections.push({
      clinicalMode: "ADULT",
      presetId: "governed-adult",
    })
    await expect(provisionBundledClinicalBaselines(conflict as never)).rejects.toMatchObject({
      code: "BUNDLED_BASELINE_SELECTION_CONFLICT",
    })
    expect(conflict.writes).toEqual([])

    const drift = new InMemoryPrisma()
    await provisionBundledClinicalBaselines(drift as never)
    const adult = drift.state.presets.find(item => item.id === "lospor-adults-v2")
    const firstRule = adult?.rules[0]
    if (!firstRule) throw new Error("missing fake adult rule")
    firstRule.payload = { drifted: true }
    drift.writes.length = 0
    await expect(provisionBundledClinicalBaselines(drift as never)).rejects.toBeInstanceOf(
      BundledBaselineProvisionError,
    )
    expect(drift.writes).toEqual([])
  })

  it("rejects login-account and unrelated audit rows using the reserved release identity", async () => {
    const accountCollision = new InMemoryPrisma()
    accountCollision.state.accountCount = 1
    await expect(provisionBundledClinicalBaselines(accountCollision as never)).rejects.toMatchObject({
      code: "BUNDLED_BASELINE_COLLISION",
    })
    expect(accountCollision.writes).toEqual([])

    const auditCollision = new InMemoryPrisma()
    auditCollision.state.audits.push({
      id: "unrelated-audit",
      userId: "lospor-release:1.2.0",
      action: "CASE_UPDATE",
      entityId: "unrelated-case",
      detail: null,
      createdAt: new Date(),
    })
    await expect(provisionBundledClinicalBaselines(auditCollision as never)).rejects.toMatchObject({
      code: "BUNDLED_BASELINE_PARTIAL_STATE",
    })
    expect(auditCollision.auditFindQueries[0]).toEqual({
      OR: expect.arrayContaining([{ userId: "lospor-release:1.2.0" }]),
    })
    expect(auditCollision.writes).toEqual([])
  })

  it("rolls all release rows back if one evidence write fails", async () => {
    const db = new InMemoryPrisma()
    db.failEvidenceNumber = 2

    await expect(provisionBundledClinicalBaselines(db as never)).rejects.toThrow(
      "simulated publication evidence failure",
    )
    expect(db.state).toEqual({
      principals: [],
      presets: [],
      selections: [],
      audits: [],
      accountCount: 0,
      sessionCount: 0,
    })
  })

  it("retries a serialization conflict and still uses one atomic install", async () => {
    const db = new InMemoryPrisma()
    db.serializeFirstAttempt = true

    await expect(provisionBundledClinicalBaselines(db as never)).resolves.toMatchObject({
      outcome: "installed",
    })
    expect(db.transactionAttempts).toBe(2)
    expect(db.state.presets).toHaveLength(4)
  })

  it("turns a repeated concurrent unique claim into a typed fail-closed collision", async () => {
    const uniqueCollision = Object.assign(new Error("unique collision"), { code: "P2002" })
    const transaction = vi.fn().mockRejectedValue(uniqueCollision)

    await expect(provisionBundledClinicalBaselines({ $transaction: transaction } as never))
      .rejects.toMatchObject({ code: "BUNDLED_BASELINE_COLLISION" })
    expect(transaction).toHaveBeenCalledTimes(3)
  })

  /** An appliance updated to 1.2.0 but not yet to 9.15.0: v2 installed and selected, nothing of v3. */
  async function applianceOnV2(): Promise<InMemoryPrisma> {
    const db = new InMemoryPrisma()
    const installedAt = new Date("2026-08-23T12:00:00.000Z")
    await provisionBundledClinicalBaselines(db as never, { installedAt })
    const v3 = new Set(["lospor-adults-v3", "lospor-pediatrics-v3"])
    db.state.principals = db.state.principals.filter(row => row.id === "lospor-release:1.2.0")
    db.state.presets = db.state.presets.filter(row => !v3.has(String(row.id)))
    db.state.audits = db.state.audits.filter(row => row.userId === "lospor-release:1.2.0")
    for (const selection of db.state.selections) {
      Object.assign(selection, {
        presetId: selection.clinicalMode === "ADULT" ? "lospor-adults-v2" : "lospor-pediatrics-v2",
        selectedByTechnicalPrincipalId: "lospor-release:1.2.0",
        selectedAt: installedAt,
        updatedAt: installedAt,
      })
    }
    db.writes.length = 0
    return db
  }

  it("upgrades a v2 appliance: installs v3 beside v2, moves the release selection, leaves v2 untouched", async () => {
    const db = await applianceOnV2()
    const v2Before = structuredClone(db.state.presets)
    const upgradedAt = new Date("2026-10-20T08:00:00.000Z")

    const result = await provisionBundledClinicalBaselines(db as never, { installedAt: upgradedAt })

    expect(result.outcome).toBe("verified")
    expect(result.v3.outcome).toBe("installed")
    expect(result.v3.baselines.map(item => item.selected)).toEqual([true, true])
    expect(db.state.presets.filter(row => String(row.id).endsWith("-v2"))).toEqual(v2Before)
    expect(db.state.selections).toEqual([
      expect.objectContaining({ clinicalMode: "ADULT", presetId: "lospor-adults-v3", selectedByTechnicalPrincipalId: "lospor-release:9.15.0", selectedAt: upgradedAt }),
      expect.objectContaining({ clinicalMode: "PEDIATRIC", presetId: "lospor-pediatrics-v3", selectedByTechnicalPrincipalId: "lospor-release:9.15.0", selectedAt: upgradedAt }),
    ])
    const evidence = db.state.presets.find(row => row.id === "lospor-adults-v3")?.publicationEvidence as Row
    expect(evidence).toMatchObject({ baselinePresetId: "lospor-adults-v2", baselinePresetVersion: 2 })
    const diff = evidence.exactDiff as { added: unknown[]; removed: unknown[]; changed: unknown[]; unchangedRuleCount: number }
    expect([diff.added.length, diff.removed.length, diff.changed.length, diff.unchangedRuleCount]).toEqual([16, 0, 59, 192])

    // The next update verifies both releases without writing.
    db.writes.length = 0
    const retry = await provisionBundledClinicalBaselines(db as never, { installedAt: new Date("2031-01-01T00:00:00.000Z") })
    expect([retry.outcome, retry.v3.outcome]).toEqual(["verified", "verified"])
    expect(db.writes).toEqual([])
  })

  it("refuses to install v3 over a platform version 3 that an administrator made", async () => {
    const db = await applianceOnV2()
    db.state.presets.push({
      id: "ruleset-admin-made",
      key: "LOSPOR_ADULTS",
      clinicalMode: "ADULT",
      scope: "PLATFORM",
      version: 3,
      status: "DRAFT",
      rules: [],
      publicationEvidence: null,
    })
    await expect(provisionBundledClinicalBaselines(db as never)).rejects.toMatchObject({
      code: "BUNDLED_BASELINE_PARTIAL_STATE",
    })
    expect(db.writes).toEqual([])
  })

  it("fails closed when stored v3 content drifts", async () => {
    const db = await applianceOnV2()
    await provisionBundledClinicalBaselines(db as never)
    const rule = db.state.presets.find(row => row.id === "lospor-pediatrics-v3")?.rules[0]
    if (!rule) throw new Error("missing fake v3 rule")
    rule.payload = { drifted: true }
    db.writes.length = 0
    await expect(provisionBundledClinicalBaselines(db as never)).rejects.toMatchObject({
      code: "BUNDLED_BASELINE_VERIFICATION_FAILED",
    })
    expect(db.writes).toEqual([])
  })
})
