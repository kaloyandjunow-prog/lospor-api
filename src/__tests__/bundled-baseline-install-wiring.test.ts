import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8")
}

describe("bundled clinical baseline clean-install wiring", () => {
  it("provisions through the shared fail-closed library in normal and E2E seeds", () => {
    const seed = source("prisma/seed.ts")
    const e2eSeed = source("scripts/seed-e2e-user.ts")
    for (const file of [seed, e2eSeed]) {
      expect(file).toContain("provisionBundledClinicalBaselines")
      expect(file).not.toContain("createLosporAdultV2Draft")
      expect(file).not.toContain("createLosporPediatricPlatformDraft")
      expect(file).not.toContain("createLosporPediatricV2Draft")
    }
    expect(seed).toContain("process.exitCode = 1")
    expect(seed).not.toContain(".catch(console.error)")
    expect(e2eSeed).not.toContain("ensurePlatformRulesets")
  })

  it("exposes a separately guarded clean-database command", () => {
    const manifest = JSON.parse(source("package.json")) as { scripts: Record<string, string> }
    const cli = source("scripts/provision-bundled-clinical-baselines.ts")
    expect(manifest.scripts["clinical-rules:provision-bundled-baselines"])
      .toBe("tsx scripts/provision-bundled-clinical-baselines.ts")
    expect(cli).toContain('process.argv.slice(2).join(" ") !== "--apply"')
    expect(cli).toContain("provisionBundledClinicalBaselines(prisma)")
  })

  it("reserves the release audit identity before it can be relabelled", () => {
    const provisioner = source("src/lib/clinical-rules/bundled-baseline-provisioner.ts")
    expect(provisioner).toContain("{ userId: principal.id }")
    expect(provisioner).toContain("tx.user.count({ where: { id: principal.id } })")
    expect(provisioner).toContain("tx.authSession.count({ where: { userId: principal.id } })")
  })
})
