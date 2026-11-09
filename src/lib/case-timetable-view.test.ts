import { describe, expect, it, vi } from "vitest"
import { caseTimetableView } from "./case-timetable-view"

function db(record: unknown, deletedRows: unknown[] = []) {
  const findFirst = vi.fn(async () => record)
  const findMany = vi.fn(async (args: { where: { status: string } }) => (args.where.status === "deleted" ? deletedRows : []))
  return { client: { case: { findFirst }, caseEvent: { findMany } } as unknown as Parameters<typeof caseTimetableView>[0], findFirst, findMany }
}

describe("the timetable viewer's read of a case", () => {
  it("asks for the chart and the procedure's name, and none of the questionnaire", async () => {
    const { client, findFirst } = db({ id: "c1", caseCode: "2026-0001" })
    await caseTimetableView(client, { id: "c1" }, { withDeleted: false })
    const args = (findFirst.mock.calls[0] as unknown as [{ where: unknown; select: Record<string, unknown>; include?: unknown }])[0]
    expect(args.where).toEqual({ id: "c1" })
    expect(args.include).toBeUndefined()
    expect(Object.keys(args.select).sort()).toEqual(["caseCode", "clinicalMode", "id", "intraop", "preop", "status"])
    expect(JSON.stringify(args.select)).not.toMatch(/assessmentAnswers|assessmentSuggestions|clinicalCalculations/)
  })

  it("is null for a case this reader may not see, and reads nothing else", async () => {
    const { client, findMany } = db(null)
    expect(await caseTimetableView(client, { id: "c1" }, { withDeleted: true })).toBeNull()
    expect(findMany).not.toHaveBeenCalled()
  })

  it("adds the deleted entries only when asked", async () => {
    const row = { logicalId: "a", version: 1, metadataJson: { id: "a", type: "drug" }, madeAt: new Date("2026-11-07T08:13:00.000Z") }
    const asked = db({ id: "c1" }, [row])
    expect((await caseTimetableView(asked.client, { id: "c1" }, { withDeleted: true }))!.deletedEvents).toEqual([expect.objectContaining({ id: "a", deletedAt: "2026-11-07T08:13:00.000Z" })])
    const notAsked = db({ id: "c1" }, [row])
    expect(await caseTimetableView(notAsked.client, { id: "c1" }, { withDeleted: false })).not.toHaveProperty("deletedEvents")
  })
})
