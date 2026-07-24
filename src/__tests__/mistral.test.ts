import { afterEach, describe, expect, it, vi } from "vitest"
import { fetchMistralChatCompletions } from "@/lib/mistral"

const originalBase = process.env.MISTRAL_API_BASE

afterEach(() => {
  process.env.MISTRAL_API_BASE = originalBase
  vi.restoreAllMocks()
})

describe("fetchMistralChatCompletions", () => {
  it("retries against the global API when a configured regional endpoint rejects inference", async () => {
    process.env.MISTRAL_API_BASE = "https://api.eu.mistral.ai/v1"
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
})
