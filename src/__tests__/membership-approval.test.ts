import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

/**
 * Public accounts activate through verified email. Role elevation, research
 * grants and institution changes keep their own explicit governance; the old
 * generic approval bit did not govern any of them and is gone.
 *
 * These read the source rather than exercising handlers, in the same style as
 * the migration tests: the point is that the dangerous line is *absent*, and a
 * behavioural test cannot show absence.
 */
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8")

describe("public email verification activates an ordinary member", () => {
  const route = read("../app/v1/auth/verify-email/route.ts")

  it("still marks the address verified", () => {
    expect(route).toContain("emailVerifiedAt")
    expect(route).toContain("activatedAt")
  })

  it("does not reference a separate approval state", () => {
    expect(route).not.toContain("approvedAt")
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
describe("sign-in requires deployment-neutral activation", () => {
  const credentials = read("../lib/credentials.ts")

  it("requires activation and an undeleted account without making contact email identity", () => {
    expect(credentials).toContain("user.activatedAt")
    expect(credentials).not.toContain("!user.emailVerifiedAt")
    expect(credentials).toContain("user.deletedAt")
  })
})

describe("a fresh installation can be bootstrapped", () => {
  const bootstrap = read("../../scripts/bootstrap-admin.ts")

  it("sets role and activation together", () => {
    // Setting `role` alone was the documented procedure, and it left an account
    // that still could not sign in.
    expect(bootstrap).toMatch(/role:\s*"ADMIN"/)
    expect(bootstrap).not.toContain("approvedAt")
    expect(bootstrap).toMatch(/activatedAt:\s*now/)
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

describe("registration has no approval queue", () => {
  it("creates a MEMBER and never returns pending state", () => {
    const registration = read("../app/v1/auth/register/route.ts")
    expect(registration).toMatch(/role:\s*"MEMBER"/)
    expect(registration).not.toContain("approvedAt")
    expect(registration).not.toMatch(/pending:\s*(true|false)/)
  })
})
