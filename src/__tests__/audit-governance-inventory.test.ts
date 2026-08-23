import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"
import { AUDIT_ACTION_REGISTRY } from "@/lib/audit-actions"
import {
  AUDIT_GOVERNANCE_INVENTORY,
  type AuditGovernanceRequirement,
} from "@/lib/audit-governance-inventory"

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), "utf8")
const normalized = (path: string) => path.replaceAll("\\", "/")

const REQUIRED_HAUD_REQUIREMENTS = [
  "ACCOUNT_PROVISION",
  "TOKEN_REISSUE",
  "ACTIVATION",
  "APPROVAL_REJECTION",
  "ROLE_CHANGE",
  "ADMIN_AUTHORITY",
  "INSTITUTION_CHANGE",
  "PASSWORD_CHANGE_RECOVERY",
  "SESSION_REVOCATION",
  "SUSPEND_REACTIVATE",
  "DELETE_RESTORE_ANONYMISE",
  "LEGAL_ACCEPTANCE",
  "RESEARCH_ACCESS",
  "CLINICAL_RULE_GOVERNANCE",
  "CENTRAL_CONTROL",
] as const satisfies readonly AuditGovernanceRequirement[]

// The clinical-rules maintenance scripts left this list once they resolved
// PUBLISHING_ADMIN_EMAIL to an active clinical administrator. Only the Play
// reviewer script still has no truthful actor.
const DECISION_BLOCKED_SCRIPTS = [
  "scripts/seed-play-reviewer.ts",
] as const

// These mutate only short-lived authentication/session bookkeeping or
// disposable test fixtures. They are deliberately outside HAUD-01's durable
// privilege/lifecycle evidence boundary, but must remain explicit so discovery
// cannot turn into a silent exclusion list.
const EXPLICIT_OUT_OF_SCOPE_MUTATION_SOURCES: Readonly<Record<string, string>> = {
  "scripts/seed-e2e-user.ts": "Disposable non-production E2E fixture setup/cleanup",
  "scripts/smoke-transfer.ts": "Disposable real-database smoke fixture setup/cleanup",
  "src/app/v1/auth/session/route.ts": "Ordinary Web sign-in/session issuance bookkeeping",
  "src/app/v1/auth/token/route.ts": "Ordinary Native sign-in/session issuance bookkeeping",
  "src/lib/auth-sessions.ts": "Low-level session helper; governed revocation callers are inventoried",
}

function sourceFiles(directory: string): string[] {
  const absolute = join(root, directory)
  return readdirSync(absolute, { withFileTypes: true }).flatMap(entry => {
    const path = join(absolute, entry.name)
    if (entry.isDirectory()) return sourceFiles(normalized(relative(root, path)))
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return []
    return [normalized(relative(root, path))]
  })
}

const governedMutation = /\b(?:prisma|tx|transaction)\.(?:user|roleRequest|institutionChangeRequest|legalAcceptance|emailVerificationToken|passwordResetToken|authSession|mfaRecoveryCode|researchAccessGrant|researchSelfAuthorization|technicalPrincipal|clinicalPreset|clinicalPresetRule|clinicalRulesetPublicationEvidence|platformClinicalPresetSelection|institutionClinicalPresetSelection|userClinicalPresetSelection|institutionClinicalRuleOverride)\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/m

describe("HAUD-01 governance inventory gate", () => {
  it("covers every FORLCAUDEFIXES privilege/lifecycle requirement", () => {
    const covered = new Set(AUDIT_GOVERNANCE_INVENTORY.map(item => item.requirement))
    expect([...covered].sort()).toEqual([...REQUIRED_HAUD_REQUIREMENTS].sort())
    expect(new Set(AUDIT_GOVERNANCE_INVENTORY.map(item => item.id)).size)
      .toBe(AUDIT_GOVERNANCE_INVENTORY.length)
  })

  it("maps every owner mutation to a registered durable action inside its transaction", () => {
    const registered = new Set(AUDIT_ACTION_REGISTRY.map(action => action.code))
    for (const item of AUDIT_GOVERNANCE_INVENTORY) {
      if (item.disposition !== "OWNER_TRANSACTIONAL") continue
      expect(item.sources.length, item.id).toBeGreaterThan(0)
      for (const source of item.sources) {
        expect(existsSync(join(root, source.path)), source.path).toBe(true)
        const code = read(source.path)
        expect(code, `${item.id} is not transaction-scoped`).toContain("$transaction")
        if (source.auditPath === "TRANSACTION_HELPER") {
          expect(code, `${item.id} bypasses the durable writer`).toContain("logAuditInTransaction")
          expect(code, `${item.id} defers audit after commit`).not.toMatch(
            /after\s*\([\s\S]{0,160}\blogAudit(?:InTransaction)?\s*\(/,
          )
        } else {
          expect(code, `${item.id} lacks an in-transaction audit row`).toContain("auditLog.create")
          expect(code, `${item.id} lacks compile-time action typing`).toContain("AuditActionCode")
        }
        for (const action of source.actionCodes) {
          expect(registered.has(action), `${item.id} uses unregistered ${action}`).toBe(true)
          expect(code, `${item.id} does not persist ${action}`).toContain(action)
        }
      }
    }
  })

  it("binds every owner transition to executable rollback evidence or an exact script limit", () => {
    for (const item of AUDIT_GOVERNANCE_INVENTORY) {
      if (item.disposition !== "OWNER_TRANSACTIONAL") continue
      expect(existsSync(join(root, item.rollback.evidencePath)), item.rollback.evidencePath).toBe(true)
      expect(read(item.rollback.evidencePath), `${item.id} rollback marker is missing`)
        .toContain(item.rollback.marker)
      if (item.rollback.kind === "SOURCE_ONLY_SCRIPT") {
        expect(
          "limit" in item ? item.limit : undefined,
          `${item.id} must explain why injection is unavailable`,
        ).toBeTruthy()
      }
    }
  })

  it("keeps public approval as a no-mutation tombstone", () => {
    const item = AUDIT_GOVERNANCE_INVENTORY.find(entry => entry.id === "public-generic-approval")
    expect(item?.disposition).toBe("PUBLIC_NO_MUTATION")
    if (!item || item.disposition !== "PUBLIC_NO_MUTATION") return
    const source = read(item.evidencePath)
    expect(source).toContain("status: 410")
    expect(source).not.toContain("$transaction")
    expect(source).not.toMatch(/\.(?:create|update|upsert|delete)(?:Many)?\s*\(/)
  })

  it("names Hospital ownership and the one remaining unresolved actor-principal script", () => {
    const hospitalOwned = AUDIT_GOVERNANCE_INVENTORY.filter(
      item => item.disposition === "HOSPITAL_OWNED",
    )
    expect(hospitalOwned.map(item => item.id).sort()).toEqual([
      "hospital-account-provision-activation-recovery",
      "hospital-central-control",
      "hospital-research-grants",
    ])
    for (const item of hospitalOwned) expect(item.limit.trim()).not.toBe("")

    const blocked = AUDIT_GOVERNANCE_INVENTORY.flatMap(item => (
      item.disposition === "DECISION_BLOCKED" ? [...item.blockedSources] : []
    )).sort()
    expect(blocked).toEqual([...DECISION_BLOCKED_SCRIPTS].sort())
    expect(blocked).toEqual(["scripts/seed-play-reviewer.ts"])
    for (const path of blocked) expect(existsSync(join(root, path)), path).toBe(true)
  })

  it("fails when a governed-model mutation source is neither inventoried nor explicitly excluded", () => {
    const inventoried = new Set<string>(AUDIT_GOVERNANCE_INVENTORY.flatMap(item => {
      if (item.disposition === "OWNER_TRANSACTIONAL") return item.sources.map(source => source.path)
      if (item.disposition === "DECISION_BLOCKED") return [...item.blockedSources]
      return []
    }))
    const discovered = ["src/app/v1", "src/lib", "scripts"]
      .flatMap(sourceFiles)
      .filter(path => governedMutation.test(read(path)))
    const unknown = discovered.filter(path => (
      !inventoried.has(path) && !(path in EXPLICIT_OUT_OF_SCOPE_MUTATION_SOURCES)
    ))
    expect(unknown).toEqual([])
    for (const [path, reason] of Object.entries(EXPLICIT_OUT_OF_SCOPE_MUTATION_SOURCES)) {
      expect(discovered, `${path} is no longer a discovered mutation; remove the stale exclusion`)
        .toContain(path)
      expect(reason.trim()).not.toBe("")
    }
  })
})

// HAUD_SOURCE_ONLY:bootstrap-first-administrator
// HAUD_SOURCE_ONLY:clinical-rules-operator-publication
// HAUD_SOURCE_ONLY:clinical-rules-operator-maintenance
