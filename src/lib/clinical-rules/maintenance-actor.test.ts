import { afterEach, describe, expect, it, vi } from "vitest"
import {
  actorTechnicalPrincipalId,
  actorUserId,
  assertMaintenanceActorConfigured,
  resolveMaintenanceActor,
  writeMaintenanceAuditRow,
  type MaintenanceActor,
} from "./maintenance-actor"

type Row = Record<string, unknown>

const RELEASE_PRINCIPAL_ID = "lospor-release:1.2.0"

class FakeTransaction {
  users: Row[] = []
  principals: Row[] = []
  audits: Row[] = []
  calls: string[] = []

  readonly user = {
    findUnique: async ({ where }: { where: { email: string } }) => {
      this.calls.push(`user.findUnique:${where.email}`)
      return this.users.find(item => item.email === where.email) ?? null
    },
  }

  readonly technicalPrincipal = {
    upsert: async ({ where, create }: { where: { id: string }; create: Row }) => {
      this.calls.push(`technicalPrincipal.upsert:${where.id}`)
      const existing = this.principals.find(item => item.id === where.id)
      if (existing) return existing
      const created = { ...create }
      this.principals.push(created)
      return created
    },
  }

  readonly auditLog = {
    create: async ({ data }: { data: Row }) => {
      this.calls.push(`auditLog.create:${String(data.action)}`)
      this.audits.push(data)
      return data
    },
  }
}

function activeAdmin(): Row {
  return { id: "user-admin", email: "admin@example.com", role: "ADMIN", deletedAt: null }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("clinical-rules maintenance actor", () => {
  it("requires a named administrator against a protected database", async () => {
    vi.stubEnv("PUBLISHING_ADMIN_EMAIL", "")
    const tx = new FakeTransaction()

    await expect(resolveMaintenanceActor(tx as never, { protectedDatabase: true }))
      .rejects.toThrow(/PUBLISHING_ADMIN_EMAIL is required against a protected database/)
    expect(tx.calls).toEqual([])
    expect(tx.principals).toEqual([])
  })

  it("attributes an unnamed run on an unprotected database to the release principal", async () => {
    vi.stubEnv("PUBLISHING_ADMIN_EMAIL", "")
    const tx = new FakeTransaction()

    const actor = await resolveMaintenanceActor(tx as never, { protectedDatabase: false })

    expect(actor).toEqual({ id: RELEASE_PRINCIPAL_ID, kind: "RELEASE" })
    expect(tx.principals).toEqual([{
      id: RELEASE_PRINCIPAL_ID,
      kind: "RELEASE",
      displayName: "LOSPOR 1.2.0",
      releaseVersion: "1.2.0",
    }])
    expect(tx.calls).toEqual([`technicalPrincipal.upsert:${RELEASE_PRINCIPAL_ID}`])
  })

  it("reuses the stored release principal instead of writing a second identity", async () => {
    vi.stubEnv("PUBLISHING_ADMIN_EMAIL", "")
    const tx = new FakeTransaction()

    const first = await resolveMaintenanceActor(tx as never, { protectedDatabase: false })
    const second = await resolveMaintenanceActor(tx as never, { protectedDatabase: false })

    expect(second).toEqual(first)
    expect(tx.principals).toHaveLength(1)
  })

  it("refuses a stored principal whose identity is not the release principal", async () => {
    vi.stubEnv("PUBLISHING_ADMIN_EMAIL", "")
    const tx = new FakeTransaction()
    tx.principals.push({
      id: RELEASE_PRINCIPAL_ID,
      kind: "RELEASE",
      displayName: "Something else",
      releaseVersion: "1.2.0",
    })

    await expect(resolveMaintenanceActor(tx as never, { protectedDatabase: false }))
      .rejects.toThrow(/exists with a different identity/)
  })

  it("honours and validates a named administrator on an unprotected database", async () => {
    vi.stubEnv("PUBLISHING_ADMIN_EMAIL", "admin@example.com")
    const tx = new FakeTransaction()
    tx.users.push(activeAdmin())

    const actor = await resolveMaintenanceActor(tx as never, { protectedDatabase: false })

    expect(actor).toEqual({ id: "user-admin", kind: "ADMIN" })
    expect(tx.calls).toEqual(["user.findUnique:admin@example.com"])
    expect(tx.principals).toEqual([])
  })

  it("resolves the named administrator against a protected database", async () => {
    vi.stubEnv("PUBLISHING_ADMIN_EMAIL", "admin@example.com")
    const tx = new FakeTransaction()
    tx.users.push(activeAdmin())

    await expect(resolveMaintenanceActor(tx as never, { protectedDatabase: true }))
      .resolves.toEqual({ id: "user-admin", kind: "ADMIN" })
  })

  it.each([
    ["an unknown address", [] as Row[]],
    ["a non-administrator", [{ ...activeAdmin(), role: "MEMBER" }]],
    ["a deleted administrator", [{ ...activeAdmin(), deletedAt: new Date() }]],
  ])("never falls back to the release principal for %s", async (_case, users) => {
    vi.stubEnv("PUBLISHING_ADMIN_EMAIL", "admin@example.com")
    for (const protectedDatabase of [false, true]) {
      const tx = new FakeTransaction()
      tx.users.push(...users)

      await expect(resolveMaintenanceActor(tx as never, { protectedDatabase }))
        .rejects.toThrow(/must identify an active platform administrator/)
      expect(tx.principals).toEqual([])
    }
  })

  it("treats a blank PUBLISHING_ADMIN_EMAIL as unsupplied", async () => {
    vi.stubEnv("PUBLISHING_ADMIN_EMAIL", "   ")
    const tx = new FakeTransaction()

    await expect(resolveMaintenanceActor(tx as never, { protectedDatabase: false }))
      .resolves.toEqual({ id: RELEASE_PRINCIPAL_ID, kind: "RELEASE" })
    await expect(resolveMaintenanceActor(tx as never, { protectedDatabase: true }))
      .rejects.toThrow(/PUBLISHING_ADMIN_EMAIL is required/)
  })

  it("fails fast before a script connects when production is unattributed", () => {
    vi.stubEnv("PUBLISHING_ADMIN_EMAIL", "")
    expect(() => assertMaintenanceActorConfigured({ protectedDatabase: true }))
      .toThrow(/PUBLISHING_ADMIN_EMAIL is required against a protected database/)
    expect(() => assertMaintenanceActorConfigured({ protectedDatabase: false })).not.toThrow()

    vi.stubEnv("PUBLISHING_ADMIN_EMAIL", "admin@example.com")
    expect(() => assertMaintenanceActorConfigured({ protectedDatabase: true })).not.toThrow()
  })

  it("writes nothing on a dry run while still validating a named administrator", async () => {
    vi.stubEnv("PUBLISHING_ADMIN_EMAIL", "")
    const unnamed = new FakeTransaction()

    await expect(resolveMaintenanceActor(unnamed as never, {
      protectedDatabase: false,
      dryRun: true,
    })).resolves.toEqual({ id: RELEASE_PRINCIPAL_ID, kind: "RELEASE" })
    expect(unnamed.principals).toEqual([])
    expect(unnamed.calls).toEqual([])

    vi.stubEnv("PUBLISHING_ADMIN_EMAIL", "admin@example.com")
    const named = new FakeTransaction()

    await expect(resolveMaintenanceActor(named as never, {
      protectedDatabase: false,
      dryRun: true,
    })).rejects.toThrow(/must identify an active platform administrator/)
  })

  it("keeps a principal id out of every User foreign key", () => {
    const admin: MaintenanceActor = { id: "user-admin", kind: "ADMIN" }
    const release: MaintenanceActor = { id: RELEASE_PRINCIPAL_ID, kind: "RELEASE" }

    expect(actorUserId(admin)).toBe("user-admin")
    expect(actorTechnicalPrincipalId(admin)).toBeNull()
    expect(actorUserId(release)).toBeNull()
    expect(actorTechnicalPrincipalId(release)).toBe(RELEASE_PRINCIPAL_ID)
  })

  it("records the actor kind and the script that produced the row", async () => {
    const tx = new FakeTransaction()

    await writeMaintenanceAuditRow(tx as never, { id: RELEASE_PRINCIPAL_ID, kind: "RELEASE" }, {
      action: "CLINICAL_RULESET_PRUNE",
      entityId: "lospor-pediatrics-v1",
      source: "scripts/prune-clinical-rulesets.ts",
      detail: { scope: "PLATFORM", ruleCount: 228 },
    })

    expect(tx.audits).toEqual([{
      userId: RELEASE_PRINCIPAL_ID,
      action: "CLINICAL_RULESET_PRUNE",
      entityId: "lospor-pediatrics-v1",
      detail: {
        scope: "PLATFORM",
        ruleCount: 228,
        actorKind: "RELEASE",
        source: "scripts/prune-clinical-rulesets.ts",
      },
    }])
  })

  it("attributes the row to the administrator when a person ran it", async () => {
    const tx = new FakeTransaction()

    await writeMaintenanceAuditRow(tx as never, { id: "user-admin", kind: "ADMIN" }, {
      action: "CLINICAL_RULESET_CREATE",
      entityId: "lospor-adults-v2",
      source: "scripts/create-platform-clinical-drafts.ts",
    })

    expect(tx.audits[0]).toMatchObject({
      userId: "user-admin",
      detail: { actorKind: "ADMIN", source: "scripts/create-platform-clinical-drafts.ts" },
    })
  })

  it("cannot be overridden by a caller-supplied actorKind or source", async () => {
    const tx = new FakeTransaction()

    await writeMaintenanceAuditRow(tx as never, { id: "user-admin", kind: "ADMIN" }, {
      action: "CLINICAL_RULESET_CREATE",
      entityId: "lospor-adults-v2",
      source: "scripts/create-platform-clinical-drafts.ts",
      detail: { actorKind: "RELEASE", source: "somewhere-else.ts" },
    })

    expect(tx.audits[0]?.detail).toEqual({
      actorKind: "ADMIN",
      source: "scripts/create-platform-clinical-drafts.ts",
    })
  })
})
