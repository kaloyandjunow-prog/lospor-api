import { afterEach, describe, expect, it, vi } from "vitest"
import { fetchMistralChatCompletions } from "@/lib/mistral"

const originalBase = process.env.MISTRAL_API_BASE
const originalFallback = process.env.MISTRAL_ALLOW_GLOBAL_FALLBACK

afterEach(() => {
  if (originalBase === undefined) delete process.env.MISTRAL_API_BASE
  else process.env.MISTRAL_API_BASE = originalBase
  if (originalFallback === undefined) delete process.env.MISTRAL_ALLOW_GLOBAL_FALLBACK
  else process.env.MISTRAL_ALLOW_GLOBAL_FALLBACK = originalFallback
  vi.restoreAllMocks()
})

describe("fetchMistralChatCompletions", () => {
  it("sends to EU inference when no endpoint is configured", async () => {
    delete process.env.MISTRAL_API_BASE
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))

    await fetchMistralChatCompletions("key", { model: "mistral-small-latest" })

    // Residency is decided here, not by the fallback flag. An unconfigured
    // deployment must not reach the global endpoint by omission.
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.eu.mistral.ai/v1/chat/completions")
  })

  it("retries against the global API when a configured regional endpoint rejects inference", async () => {
    process.env.MISTRAL_API_BASE = "https://api.eu.mistral.ai/v1"
    process.env.MISTRAL_ALLOW_GLOBAL_FALLBACK = "true"
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({
        type: "regional_inference_not_allowed",
        code: "1914",
      }), { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))

    const res = await fetchMistralChatCompletions("key", { model: "mistral-small-latest" })

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.eu.mistral.ai/v1/chat/completions")
    expect(String(fetchMock.mock.calls[1][0])).toBe("https://api.mistral.ai/v1/chat/completions")
  })

  it("does not retry non-regional provider errors", async () => {
    process.env.MISTRAL_API_BASE = "https://api.eu.mistral.ai/v1"
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "bad request" }), { status: 400 }))

    const res = await fetchMistralChatCompletions("key", { model: "mistral-small-latest" })

    expect(res.status).toBe(400)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("does not silently move a clinical payload out of region", async () => {
    process.env.MISTRAL_API_BASE = "https://api.eu.mistral.ai/v1"
    process.env.MISTRAL_ALLOW_GLOBAL_FALLBACK = "false"
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      type: "regional_inference_not_allowed",
    }), { status: 403 }))

    const response = await fetchMistralChatCompletions("secret", { messages: [] })

    expect(response.status).toBe(403)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("keeps the transfer off when the flag is simply absent", async () => {
    process.env.MISTRAL_API_BASE = "https://api.eu.mistral.ai/v1"
    delete process.env.MISTRAL_ALLOW_GLOBAL_FALLBACK
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
      type: "regional_inference_not_allowed",
      code: "1914",
    }), { status: 403 }))

    const response = await fetchMistralChatCompletions("secret", { messages: [] })

    expect(response.status).toBe(403)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
