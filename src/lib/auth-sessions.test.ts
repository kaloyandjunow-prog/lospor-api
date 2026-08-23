import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

const mocks = vi.hoisted(() => ({ findUnique: vi.fn(), updateMany: vi.fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: { authSession: { findUnique: mocks.findUnique, updateMany: mocks.updateMany } },
}))

import {
  normalizeDeviceLabel,
  SESSION_LAST_SEEN_WRITE_INTERVAL_MS,
  validateTrackedSession,
} from "./auth-sessions"

describe("tracked-session validation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.updateMany.mockResolvedValue({ count: 1 })
  })

  it("fails closed for absent, mismatched, revoked, and expired rows", async () => {
    for (const row of [
      null,
      { userId: "other", revokedAt: null, expiresAt: new Date(Date.now() + 60_000), lastSeenAt: new Date() },
      { userId: "user-1", revokedAt: new Date(), expiresAt: new Date(Date.now() + 60_000), lastSeenAt: new Date() },
      { userId: "user-1", revokedAt: null, expiresAt: new Date(Date.now() - 1), lastSeenAt: new Date() },
    ]) {
      mocks.findUnique.mockResolvedValueOnce(row)
      await expect(validateTrackedSession("jti-1", "user-1")).resolves.toBe(false)
    }
  })

  it("accepts an active row and periodically persists last-seen", async () => {
    mocks.findUnique.mockResolvedValue({
      userId: "user-1",
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      lastSeenAt: new Date(Date.now() - SESSION_LAST_SEEN_WRITE_INTERVAL_MS - 1),
    })
    await expect(validateTrackedSession("jti-1", "user-1")).resolves.toBe(true)
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ jti: "jti-1", userId: "user-1", revokedAt: null }),
      data: { lastSeenAt: expect.any(Date) },
    }))
  })

  it("normalizes untrusted device labels without retaining control whitespace or excess length", () => {
    expect(normalizeDeviceLabel("  Ward\n iPad  ", "Device")).toBe("Ward iPad")
    expect(normalizeDeviceLabel("x".repeat(200), "Device")).toHaveLength(120)
    expect(normalizeDeviceLabel("   ", "Device")).toBe("Device")
  })
})
