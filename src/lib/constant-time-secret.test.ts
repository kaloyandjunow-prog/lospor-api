import { describe, expect, it } from "vitest"
import { bearerToken, matchesSecret } from "@/lib/constant-time-secret"

describe("comparing internal secrets", () => {
  it("accepts the configured secret", () => {
    expect(matchesSecret("s3cret-value", "s3cret-value")).toBe(true)
  })

  it("rejects a wrong secret of the same length", () => {
    expect(matchesSecret("s3cret-valuf", "s3cret-value")).toBe(false)
  })

  it("rejects a correct prefix", () => {
    // The attack the constant-time comparison exists for: `===` returns at the
    // first differing byte, so a longer correct prefix takes measurably longer
    // and the secret can be recovered a byte at a time.
    expect(matchesSecret("s3cret-valu", "s3cret-value")).toBe(false)
    expect(matchesSecret("s", "s3cret-value")).toBe(false)
  })

  it("rejects an empty presented secret", () => {
    expect(matchesSecret("", "s3cret-value")).toBe(false)
  })

  it("does not throw on a length mismatch", () => {
    // timingSafeEqual throws on differing lengths, so the length check has to
    // come first; without it an over-long header would 500 instead of 403.
    expect(() => matchesSecret("a".repeat(4096), "short")).not.toThrow()
    expect(matchesSecret("a".repeat(4096), "short")).toBe(false)
  })

  it("compares bytes, not characters", () => {
    // Two strings of equal character length can differ in byte length once
    // encoded, which is exactly when timingSafeEqual would throw.
    expect(() => matchesSecret("é", "e")).not.toThrow()
    expect(matchesSecret("é", "e")).toBe(false)
  })
})

describe("reading a bearer token", () => {
  const withHeader = (value: string | null) =>
    new Request("http://localhost/internal", {
      headers: value === null ? {} : { authorization: value },
    })

  it("reads the token after the scheme", () => {
    expect(bearerToken(withHeader("Bearer abc123"))).toBe("abc123")
  })

  it("returns an empty string when the header is missing or another scheme", () => {
    expect(bearerToken(withHeader(null))).toBe("")
    expect(bearerToken(withHeader("Basic abc123"))).toBe("")
    // Case matters: the scheme is compared literally, and an empty result
    // simply fails the secret comparison rather than being treated as absent.
    expect(bearerToken(withHeader("bearer abc123"))).toBe("")
  })
})
