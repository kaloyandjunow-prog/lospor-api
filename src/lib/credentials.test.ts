import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  compare: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findUnique: mocks.findUnique } },
}))
vi.mock("bcryptjs", () => ({
  default: { compare: mocks.compare },
}))

import { verifyCredentials, verifyCurrentPassword } from "./credentials"

const activeAccount = {
  id: "user-1",
  email: null,
  username: "Clinician.One",
  usernameCanonical: "clinician.one",
  passwordHash: "hash",
  activatedAt: new Date(),
  deletedAt: null,
  suspendedAt: null,
  recoveryRequiredAt: null,
  anonymizedAt: null,
  institution: null,
  legalAcceptances: [],
}

describe("deployment-bound credential lookup", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.findUnique.mockResolvedValue(activeAccount)
    mocks.compare.mockResolvedValue(true)
  })

  it("looks up a Hospital identity only by its canonical username", async () => {
    await expect(verifyCredentials(
      { kind: "USERNAME", canonical: "clinician.one" },
      "secret",
    )).resolves.toBe(activeAccount)
    expect(mocks.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { usernameCanonical: "clinician.one" },
    }))
  })

  it("looks up a public identity only by normalized email", async () => {
    mocks.findUnique.mockResolvedValue({ ...activeAccount, username: null, usernameCanonical: null })
    await expect(verifyCredentials(
      { kind: "EMAIL", canonical: "doctor@example.test" },
      "secret",
    )).resolves.toEqual(expect.objectContaining({ usernameCanonical: null }))
    expect(mocks.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { email: "doctor@example.test" },
    }))
  })

  it("never treats a Hospital contact email as a public login fallback", async () => {
    mocks.findUnique.mockResolvedValue({ ...activeAccount, email: "contact@example.test" })
    await expect(verifyCredentials(
      { kind: "EMAIL", canonical: "contact@example.test" },
      "secret",
    )).resolves.toBeNull()
  })

  it.each([
    ["inactive", { activatedAt: null }],
    ["deleted", { deletedAt: new Date() }],
    ["suspended", { suspendedAt: new Date() }],
    ["recovery", { recoveryRequiredAt: new Date() }],
    ["anonymized", { anonymizedAt: new Date() }],
  ])("rejects a valid password for an %s account", async (_name, state) => {
    mocks.findUnique.mockResolvedValue({ ...activeAccount, ...state })
    await expect(verifyCredentials(
      { kind: "USERNAME", canonical: "clinician.one" },
      "secret",
    )).resolves.toBeNull()
  })

  it("uses activatedAt for sensitive-operation reauthentication", async () => {
    mocks.findUnique.mockResolvedValue({
      passwordHash: "hash",
      activatedAt: null,
      deletedAt: null,
      suspendedAt: null,
      recoveryRequiredAt: null,
      anonymizedAt: null,
    })
    await expect(verifyCurrentPassword("user-1", "secret")).resolves.toBe(false)
    expect(mocks.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "user-1" },
      select: expect.objectContaining({ activatedAt: true }),
    }))
  })
})
