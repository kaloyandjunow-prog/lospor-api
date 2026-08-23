import { describe, expect, it } from "vitest"
import { isHodDemotion, membershipChangeData } from "./membership-change"
import { readFileSync } from "node:fs"

describe("institution-change role safety", () => {
  it("atomically demotes a head who leaves their department", () => {
    expect(membershipChangeData({ id: "hod", role: "HEAD_OF_DEPT", institutionId: "a" }, "b"))
      .toEqual({ institutionId: "b", role: "MEMBER" })
  })

  it("does not rewrite ordinary roles or same-institution updates", () => {
    expect(membershipChangeData({ id: "member", role: "MEMBER", institutionId: "a" }, "b"))
      .toEqual({ institutionId: "b" })
    expect(membershipChangeData({ id: "hod", role: "HEAD_OF_DEPT", institutionId: "a" }, "a"))
      .toEqual({ institutionId: "a" })
  })

  it("identifies only a real HOD-to-member loss of department authority", () => {
    expect(isHodDemotion({ id: "hod", role: "HEAD_OF_DEPT", institutionId: "a" }, "MEMBER")).toBe(true)
    expect(isHodDemotion({ id: "hod", role: "HEAD_OF_DEPT", institutionId: "a" }, "HEAD_OF_DEPT")).toBe(false)
    expect(isHodDemotion({ id: "member", role: "MEMBER", institutionId: "a" }, "MEMBER")).toBe(false)
  })
})

describe("institution routes use the locked transition", () => {
  it("locks, demotes and invalidates both approved moves and self-leaves", () => {
    for (const path of [
      "../app/v1/admin/institution-requests/[id]/route.ts",
      "../app/v1/user/institution-request/route.ts",
    ]) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8")
      expect(source).toContain("lockMembership")
      expect(source).toContain("membershipChangeData")
      expect(source).toContain("releaseUnrelatedHodLocks")
      expect(source).toContain("invalidateAccountState")
    }
  })

  it("releases only locks on cases that are not assigned to the demoted HOD", () => {
    const source = readFileSync(new URL("./membership-change.ts", import.meta.url), "utf8")
    expect(source).toContain('lock."userId" = ${userId}')
    expect(source).toContain('clinical_case."userId" <> ${userId}')
  })
})
