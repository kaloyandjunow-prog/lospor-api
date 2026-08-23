import { describe, expect, it } from "vitest"
import {
  canonicalizeUsername,
  normalizeRequiredUsername,
  normalizeUsernameDisplay,
  validateAndNormalizeUsername,
} from "./username-identity"

describe("Hospital username identity", () => {
  it("preserves display case exactly and derives one lowercase lookup key", () => {
    expect(validateAndNormalizeUsername("Dr.Smith-2")).toEqual({
      success: true,
      value: { username: "Dr.Smith-2", usernameCanonical: "dr.smith-2" },
    })
    expect(canonicalizeUsername("DR.SMITH-2")).toBe("dr.smith-2")
  })

  it("does not trim or compatibility-normalize the entered spelling", () => {
    expect(normalizeUsernameDisplay(" DrSmith ")).toBe(" DrSmith ")
    expect(validateAndNormalizeUsername(" DrSmith ")).toEqual({
      success: false,
      code: "USERNAME_FORMAT",
    })
    expect(validateAndNormalizeUsername("ＤｒSmith")).toEqual({
      success: false,
      code: "USERNAME_FORMAT",
    })
  })

  it.each([
    [undefined, "USERNAME_REQUIRED"],
    ["ab", "USERNAME_LENGTH"],
    [`a${"b".repeat(64)}`, "USERNAME_LENGTH"],
    ["2doctor", "USERNAME_FORMAT"],
    ["Dr Smith", "USERNAME_FORMAT"],
    ["dr@example", "USERNAME_FORMAT"],
    ["dr/name", "USERNAME_FORMAT"],
    ["dr\\name", "USERNAME_FORMAT"],
    ["dr\nname", "USERNAME_FORMAT"],
    ["доктор", "USERNAME_FORMAT"],
  ])("rejects unsafe username %j", (value, code) => {
    expect(validateAndNormalizeUsername(value)).toEqual({ success: false, code })
  })

  it("makes differently cased spellings collide on the same canonical key", () => {
    const first = normalizeRequiredUsername("Clinician.One")
    const second = normalizeRequiredUsername("CLINICIAN.ONE")
    expect(first.username).not.toBe(second.username)
    expect(first.usernameCanonical).toBe(second.usernameCanonical)
  })

  it.each([
    "Admin",
    "ROOT",
    "system.operator",
    "lospor-release",
  ])("does not reserve otherwise valid username or prefix %s", username => {
    expect(validateAndNormalizeUsername(username)).toEqual({
      success: true,
      value: { username, usernameCanonical: username.toLowerCase() },
    })
  })
})
