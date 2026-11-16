import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

const { sendTransactionalEmail } = await import("./transactional-email")

const message = {
  to: { email: "anaesthetist@example.org", name: "A. Person" },
  subject: "Verify your LOSPOR email",
  html: "<p>x</p>",
  text: "x",
}

/**
 * Callers log what this module throws or prints. The recipient's address and
 * whatever Brevo echoes back must stay out of both.
 */
describe("transactional email keeps addresses out of the log", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("does not print the recipient when no provider key is set", async () => {
    vi.stubEnv("BREVO_API_KEY", "")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    await expect(sendTransactionalEmail(message)).resolves.toMatchObject({ sent: false })

    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).not.toContain("anaesthetist@example.org")
  })

  it("keeps Brevo's error code and drops the body that repeats the address", async () => {
    vi.stubEnv("BREVO_API_KEY", "test-key")
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ code: "invalid_parameter", message: "email is not valid: anaesthetist@example.org" }),
      { status: 400, headers: { "content-type": "application/json" } },
    )))

    const error = await sendTransactionalEmail(message).then(() => null, (caught: unknown) => caught as Error)

    expect(error).toBeInstanceOf(Error)
    expect(error?.message).toBe("Brevo email failed 400 (invalid_parameter)")
  })

  it("keeps only the status when the body is not a bare code", async () => {
    vi.stubEnv("BREVO_API_KEY", "test-key")
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ code: "anaesthetist@example.org" }),
      { status: 400, headers: { "content-type": "application/json" } },
    )))

    const error = await sendTransactionalEmail(message).then(() => null, (caught: unknown) => caught as Error)

    expect(error?.message).toBe("Brevo email failed 400")
  })
})
