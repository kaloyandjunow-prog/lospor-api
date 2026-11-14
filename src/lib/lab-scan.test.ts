import { afterEach, describe, expect, it, vi } from "vitest"

const fetchMistral = vi.fn()
vi.mock("@/lib/mistral", () => ({ fetchMistralChatCompletions: (...args: unknown[]) => fetchMistral(...args) }))

const { scanLabImage } = await import("./lab-scan")

const answer = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] }), { status: 200 })
const input = { apiKey: "k", model: "mistral-large-2512", imageBase64: "iVBORw0KGgo=", mimeType: "image/png", timeoutMs: 1000 }

afterEach(() => fetchMistral.mockReset())

describe("scanLabImage (10.4.1)", () => {
  it("asks in JSON mode and converts each row from its printed unit", async () => {
    fetchMistral.mockResolvedValue(answer({ results: [{ printedName: "Глюкоза", section: "", test: "Glucose", value: "4.4", unit: "mmol/L" }] }))
    const outcome = await scanLabImage(input)
    expect(fetchMistral.mock.calls[0][1]).toMatchObject({ model: "mistral-large-2512", response_format: { type: "json_object" } })
    expect(outcome).toMatchObject({ ok: true, unreadable: false, results: [{ test: "Glucose", value: "4.4", sourceValue: "4.4", sourceUnit: "mmol/L" }] })
  })

  it("sends the hospital's own names and applies them to the answer", async () => {
    fetchMistral.mockResolvedValue(answer({ results: [{ printedName: "ctHb", section: "", test: "", value: "75", unit: "g/L" }] }))
    const outcome = await scanLabImage({ ...input, local: { aliases: [{ printed: "ctHb", test: "Haemoglobin (Hb)" }], instructions: "" } })
    const prompt = (fetchMistral.mock.calls[0][1] as { messages: { content: { text?: string }[] }[] }).messages[0].content[1].text
    expect(prompt).toMatch(/"ctHb" -> Haemoglobin \(Hb\)/)
    expect(outcome.ok && outcome.results.map(row => row.test)).toEqual(["Haemoglobin (Hb)"])
  })

  it("says an answer it cannot read is unreadable, without its content", async () => {
    fetchMistral.mockResolvedValue(answer("Here is the table"))
    expect(await scanLabImage(input)).toEqual({ ok: true, results: [], unreadable: true })
  })

  it("hands a provider refusal back with its response, and names a timeout", async () => {
    const refused = new Response("{}", { status: 403 })
    fetchMistral.mockResolvedValue(refused)
    expect(await scanLabImage(input)).toEqual({ ok: false, kind: "provider", response: refused })
    fetchMistral.mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }))
    expect(await scanLabImage(input)).toEqual({ ok: false, kind: "timeout" })
  })
})
