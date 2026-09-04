import { describe, expect, it } from "vitest"

import { mapIntraopUpdate } from "@/app/v1/cases/_mappers"

/**
 * A monitoring value is bound to the monitor that produced it.
 *
 * Unticking BIS and leaving a stored 42 behind would export a reading from a
 * monitor the same record says was not used. That is a contradiction rather
 * than data, and it is the sort that survives for years because both halves
 * look reasonable on their own.
 */
describe("a monitoring value does not outlive its monitor", () => {
  it("clears the value when the monitor is turned off", () => {
    const patch = mapIntraopUpdate({ bis: false })

    expect(patch.bisValue).toBeNull()
  })

  it("clears only the monitor that was turned off", () => {
    // Turning off BIS must not take the train-of-four with it. Clearing too
    // much is as wrong as clearing too little.
    const patch = mapIntraopUpdate({ bis: false, tofMonitor: true, cvpMonitor: true })

    expect(patch.bisValue).toBeNull()
    expect("tofRatio" in patch).toBe(false)
    expect("cvpMmHg" in patch).toBe(false)
  })

  /**
   * The autosave case, and the reason this keys on `has(flag)` rather than on
   * the flag's value. The intraoperative screen saves constantly while a case
   * is running. A save triggered by, say, a fluid total sends no monitoring
   * fields at all, and must not be read as "every monitor is off" — that would
   * wipe a BIS the moment anyone charted anything else.
   */
  it("leaves values alone when the patch never mentions monitoring", () => {
    const patch = mapIntraopUpdate({ urineMl: 250 })

    expect("bisValue" in patch).toBe(false)
    expect("tofRatio" in patch).toBe(false)
    expect("cvpMmHg" in patch).toBe(false)
  })

  it("keeps a value sent alongside its own monitor", () => {
    const patch = mapIntraopUpdate({ cvpMonitor: true, cvpMmHg: 7.4 })

    expect(patch.cvpMmHg).toBe(7.4)
  })

  it("clears a value even when the same patch tries to set it", () => {
    // The monitor is the authority. A payload saying "BIS off, BIS 42" is
    // incoherent, and the honest resolution is the one that cannot leave a
    // reading without a monitor behind it.
    const patch = mapIntraopUpdate({ bis: false, bisValue: 42 })

    expect(patch.bisValue).toBeNull()
  })
})
