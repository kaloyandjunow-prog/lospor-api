import { describe, expect, it } from "vitest"
import { clinicalEventSource } from "./event-provenance"

describe("clinical event provenance", () => {
  it.each([
    ["WEB", "web"],
    ["PWA", "mobile"],
    ["NATIVE", "mobile"],
  ] as const)("maps a %s session to %s", (clientType, expected) => {
    expect(clinicalEventSource({ clientType })).toBe(expected)
  })

  it("fails a legacy or incomplete identity toward Web instead of trusting request input", () => {
    expect(clinicalEventSource({})).toBe("web")
    expect(clinicalEventSource({ clientType: null })).toBe("web")
  })
})
