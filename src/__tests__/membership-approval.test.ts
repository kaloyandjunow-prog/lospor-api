import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

/**
 * Institutional membership decides who can see whose patients: a head of
 * department sees the cases of their institution. Three things undermined that.
 *
 *  - Verifying an email address also set `approvedAt`, so clicking the link in
 *    your own inbox approved your own account and the admin approval queue
 *    could never gate anything.
 *  - Nothing checked `approvedAt` when signing in, so "approval" only governed
 *    whether someone appeared in colleague lists.
 *  - Any authenticated user could PATCH their own `institutionId`, moving
 *    themselves into another hospital's department at will.
 *
 * These read the source rather than exercising handlers, in the same style as
 * the migration tests: the point is that the dangerous line is *absent*, and a
 * behavioural test cannot show absence.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

describe("email verification does not approve the account", () => {
  const route = read("../app/v1/auth/verify-email/route.ts")

  it("still marks the address verified", () => {
    expect(route).toContain("emailVerifiedAt")
  })

  it("no longer sets approvedAt", () => {
    // Approval is granted by an administrator, not by the person registering.
    expect(route).not.toMatch(/approvedAt:\s*verificationToken/)
    expect(route).not.toMatch(/approvedAt:\s*now/)
  })
})

/**
 * Approval used to gate signing in. That deadlocked every fresh installation —
 * the first user registers unapproved, only an ADMIN can approve, and the seed
 * creates no ADMIN — and it protected less than it looked like it did, because
 * what a signed-in user can see is decided by role: a MEMBER sees only their
 * own cases. Approval now gates what an account may become and where it may
 * belong, which is where the department boundary actually lives.
 */
describe("sign-in requires a verified address, not approval", () => {
  const credentials = read("../lib/credentials.ts")

  it("does not reject an unapproved account", () => {
    expect(credentials).not.toMatch(/if \(!user\.approvedAt\) return null/)
  })

  it("still requires a verified email and an undeleted account", () => {
    expect(credentials).toContain("user.emailVerifiedAt")
    expect(credentials).toContain("user.deletedAt")
  })
})

describe("a fresh installation can be bootstrapped", () => {
  const bootstrap = read("../../scripts/bootstrap-admin.ts")

  it("sets role, approval and verification together", () => {
    // Setting `role` alone was the documented procedure, and it left an account
    // that still could not sign in.
    expect(bootstrap).toMatch(/role:\s*"ADMIN"/)
    expect(bootstrap).toMatch(/approvedAt:\s*now/)
    expect(bootstrap).toMatch(/emailVerifiedAt:\s*now/)
  })

  it("refuses to run once an administrator exists", () => {
    expect(bootstrap).toMatch(/role:\s*"ADMIN",\s*deletedAt:\s*null/)
  })
})

describe("institution is not self-editable", () => {
  const route = read("../app/v1/user/route.ts")

  it("is absent from the self-service patch schema", () => {
    const schema = route.slice(route.indexOf("const patchSchema"), route.indexOf("function asPreferenceObject"))
    expect(schema).not.toMatch(/^\s*institutionId:/m)
  })

  it("is never written by the self-service update", () => {
    expect(route).not.toMatch(/institutionId: body\.institutionId/)
  })

  it("still lets a user change their own preferences", () => {
    expect(route).toContain("preferences: preferencesPatchSchema.optional()")
  })
})

describe("registration leaves the account pending", () => {
  it("sets approvedAt to null so an administrator must act", () => {
    expect(read("../app/v1/auth/register/route.ts")).toMatch(/approvedAt:\s*null/)
  })
})
