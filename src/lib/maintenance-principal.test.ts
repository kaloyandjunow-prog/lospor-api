import { describe, expect, it, vi } from "vitest"
import { LOSPOR_BUNDLED_BASELINE_RELEASE } from "@/lib/clinical-rules/bundled-baseline-contract"
import { isAuditActionCode } from "@/lib/audit-actions"
import {
  MAINTENANCE_SCRIPTS,
  MAINTENANCE_TECHNICAL_PRINCIPAL,
  ensureMaintenancePrincipal,
  recordMaintenanceAudit,
} from "@/lib/maintenance-principal"

type PrincipalUpsert = {
  where: { id: string }
  create: { id: string; kind: string; displayName: string; releaseVersion: string }
  update: Record<string, unknown>
}

type AuditCreate = {
  data: {
    userId: string
    action: string
    entityId: string
    detail: Record<string, unknown>
  }
}

function principalWriter() {
  const upsert = vi.fn(async (_args: PrincipalUpsert) => ({}))
  return { upsert, tx: { technicalPrincipal: { upsert } } as never }
}

function auditWriter() {
  const create = vi.fn(async (_args: AuditCreate) => ({}))
  return { create, tx: { auditLog: { create } } as never }
}

describe("maintenance principal", () => {
  it("is the release principal, not a person and not a signable account", async () => {
    const { upsert, tx } = principalWriter()
    const actorId = await ensureMaintenancePrincipal(tx)

    expect(actorId).toBe("lospor-release:1.2.0")
    expect(actorId).toBe(MAINTENANCE_TECHNICAL_PRINCIPAL.id)
    expect(MAINTENANCE_TECHNICAL_PRINCIPAL.kind).toBe("RELEASE")
    // No email, no password, nothing that could be mistaken for a User row.
    expect(Object.keys(MAINTENANCE_TECHNICAL_PRINCIPAL).sort())
      .toEqual(["displayName", "id", "kind"])

    expect(upsert).toHaveBeenCalledTimes(1)
    const call = upsert.mock.calls[0]![0]
    expect(call.where.id).toBe(actorId)
    expect(call.create.releaseVersion).toBe(LOSPOR_BUNDLED_BASELINE_RELEASE.releaseVersion)
    // Idempotent by design: re-running a guarded script must not fail on the
    // principal row, and must not silently rename an earlier release's.
    expect(call.update).toEqual({ displayName: MAINTENANCE_TECHNICAL_PRINCIPAL.displayName })
  })

  it("writes the actor, the script and the release into every audit row", async () => {
    const { create, tx } = auditWriter()
    await recordMaintenanceAudit(tx, {
      actorId: MAINTENANCE_TECHNICAL_PRINCIPAL.id,
      action: "CLINICAL_RULESET_PRUNE",
      entityId: "lospor-pediatrics-v1",
      script: "clinical-rules:prune",
      detail: { presetKey: "LOSPOR_PEDIATRICS", ruleCount: 235 },
    })

    expect(create).toHaveBeenCalledTimes(1)
    const { data } = create.mock.calls[0]![0]
    expect(data.userId).toBe("lospor-release:1.2.0")
    expect(data.action).toBe("CLINICAL_RULESET_PRUNE")
    expect(data.entityId).toBe("lospor-pediatrics-v1")
    expect(data.detail).toEqual({
      presetKey: "LOSPOR_PEDIATRICS",
      ruleCount: 235,
      actorKind: "TECHNICAL_PRINCIPAL",
      principalId: "lospor-release:1.2.0",
      script: "clinical-rules:prune",
      releaseVersion: "1.2.0",
    })
  })

  it("marks the actor as technical, so a reader cannot mistake it for a clinician", async () => {
    const { create, tx } = auditWriter()
    await recordMaintenanceAudit(tx, {
      actorId: MAINTENANCE_TECHNICAL_PRINCIPAL.id,
      action: "CLINICAL_RULESET_RULE_UPSERT",
      entityId: "lospor-pediatrics-v1",
      script: "clinical-rules:append-pediatric-fluid-profiles",
      detail: { appendedRuleCount: 51 },
    })
    const { data } = create.mock.calls[0]![0]
    expect(data.detail.actorKind).toBe("TECHNICAL_PRINCIPAL")
    expect(data.detail.appendedRuleCount).toBe(51)
  })

  it("covers only release-content scripts, never account provisioning", () => {
    // seed-play-reviewer.ts provisions and resets a live production account
    // whenever an operator runs it. The release did not do that and cannot
    // vouch for it, so it stays outside this principal and DECISION_BLOCKED.
    for (const script of MAINTENANCE_SCRIPTS) {
      expect(script.startsWith("clinical-rules:"), script).toBe(true)
    }
    expect([...MAINTENANCE_SCRIPTS]).not.toContain("seed:play-reviewer")
  })

  it("cannot have its caller-supplied detail overwrite the attribution", async () => {
    const { create, tx } = auditWriter()
    await recordMaintenanceAudit(tx, {
      actorId: MAINTENANCE_TECHNICAL_PRINCIPAL.id,
      action: "CLINICAL_RULESET_CREATE",
      entityId: "lospor-adults-v2",
      script: "clinical-rules:create-platform-drafts",
      detail: { actorKind: "HUMAN", principalId: "someone-else", script: "elsewhere" },
    })
    const { data } = create.mock.calls[0]![0]
    expect(data.detail.actorKind).toBe("TECHNICAL_PRINCIPAL")
    expect(data.detail.principalId).toBe("lospor-release:1.2.0")
    expect(data.detail.script).toBe("clinical-rules:create-platform-drafts")
  })

  it("names five scripts, each with an npm-script identity a reader can look up", () => {
    expect(MAINTENANCE_SCRIPTS).toHaveLength(5)
    expect(new Set(MAINTENANCE_SCRIPTS).size).toBe(5)
    for (const script of MAINTENANCE_SCRIPTS) expect(script).toMatch(/^[a-z-]+:[a-z0-9-]+$/)
  })

  it("uses only registered audit action codes", () => {
    for (const code of [
      "CLINICAL_RULESET_CREATE",
      "CLINICAL_RULESET_RULE_UPSERT",
      "CLINICAL_RULESET_PRUNE",
    ]) {
      expect(isAuditActionCode(code), code).toBe(true)
    }
  })
})
