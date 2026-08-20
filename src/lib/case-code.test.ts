import { describe, expect, it, vi } from "vitest"
import { generateCaseCode, reserveCaseCode } from "./case-code"

/**
 * A `Db` standing in for the counter table.
 *
 * `stored` is the row's `next` value, or null when the clinician has no counter
 * for that year yet.
 */
function db(stored: number | null) {
  const state = { next: stored }
  const upsert = vi.fn().mockImplementation(({ create, update }) => {
    if (state.next === null) state.next = create.next
    else state.next += update.next.increment
    return Promise.resolve({ next: state.next })
  })
  const findUnique = vi.fn().mockImplementation(() =>
    Promise.resolve(state.next === null ? null : { next: state.next }))
  const create = vi.fn().mockImplementation(({ data }) => {
    state.next = data.next
    return Promise.resolve(data)
  })
  const update = vi.fn().mockImplementation(({ data }) => {
    state.next = data.next
    return Promise.resolve(data)
  })
  return {
    client: { caseCodeSequence: { upsert, findUnique, create, update } } as never,
    state, upsert, findUnique, create, update,
  }
}

describe("case codes", () => {
  it("starts a clinician's year at 0001", async () => {
    const { client } = db(null)
    expect(await generateCaseCode("user-1", client, 2026)).toBe("2026-0001")
  })

  it("issues consecutive numbers", async () => {
    const { client } = db(null)
    const issued = []
    for (let n = 0; n < 3; n++) issued.push(await generateCaseCode("user-1", client, 2026))
    expect(issued).toEqual(["2026-0001", "2026-0002", "2026-0003"])
  })

  it("continues from the stored counter", async () => {
    const { client } = db(42)
    expect(await generateCaseCode("user-1", client, 2026)).toBe("2026-0042")
  })

  it("defaults to the current year", async () => {
    const { client } = db(null)
    const code = await generateCaseCode("user-1", client)
    expect(code.startsWith(`${new Date().getFullYear()}-`)).toBe(true)
  })

  // Renumbering on handover must stay inside the case's own year: a case
  // performed in December and accepted in January would otherwise be moved into
  // the recipient's next year, and that number is printed on the chart.
  it("can be pinned to the year the case belongs to", async () => {
    const { client, upsert } = db(null)
    expect(await generateCaseCode("user-1", client, 2019)).toBe("2019-0001")
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId_year: { userId: "user-1", year: 2019 } } }),
    )
  })
})

describe("reserving a code that arrived by handover", () => {
  // The bug this exists for. A handed-over case usually keeps its number, so it
  // lands in the recipient's sequence without their counter knowing. Left alone
  // the counter walks up to it and issues it a second time, and two operations
  // then carry the same number.
  it("pushes the counter past an incoming number", async () => {
    const { client, state } = db(2)
    await reserveCaseCode("user-1", client, "2026-0007")
    expect(state.next).toBe(8)
    expect(await generateCaseCode("user-1", client, 2026)).toBe("2026-0008")
  })

  it("creates a counter when the recipient has none for that year", async () => {
    const { client, state, create } = db(null)
    await reserveCaseCode("user-1", client, "2026-0004")
    expect(create).toHaveBeenCalled()
    expect(state.next).toBe(5)
  })

  // A clinician who receives an old, low-numbered case must not have their
  // counter dragged back over numbers they have already been issued.
  it("never moves the counter backwards", async () => {
    const { client, state, update } = db(50)
    await reserveCaseCode("user-1", client, "2026-0004")
    expect(update).not.toHaveBeenCalled()
    expect(state.next).toBe(50)
  })

  it("ignores a code it cannot parse", async () => {
    const { client, findUnique } = db(5)
    await reserveCaseCode("user-1", client, "not-a-code")
    expect(findUnique).not.toHaveBeenCalled()
  })
})
