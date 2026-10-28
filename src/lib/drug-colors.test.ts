import { describe, expect, it, vi } from "vitest"
import { DrugColorError, drugColorsView, setDrugColor } from "./drug-colors"

type Row = { category: string; labelEn: string; labelBg: string | null; group: string | null; color: string | null }

function fakeDb(options: Row[], colors: { scope: string; name: string; color: string }[] = []) {
  const db = {
    optionLibrary: {
      findMany: vi.fn(async () => options),
      count: vi.fn(async ({ where }: { where: { group?: string; labelEn?: string } }) =>
        options.filter(option => (where.group ? option.group === where.group : option.labelEn === where.labelEn)).length),
    },
    drugColor: {
      findMany: vi.fn(async () => colors),
      upsert: vi.fn(async ({ create }: { create: { scope: string; name: string; color: string } }) => {
        const existing = colors.find(row => row.scope === create.scope && row.name === create.name)
        if (existing) existing.color = create.color
        else colors.push({ ...create })
      }),
      deleteMany: vi.fn(async ({ where }: { where: { scope: string; name: string } }) => {
        const index = colors.findIndex(row => row.scope === where.scope && row.name === where.name)
        if (index >= 0) colors.splice(index, 1)
      }),
    },
  }
  return db as unknown as Parameters<typeof drugColorsView>[0] & typeof db
}

const OPIOIDS = "Opioid analgesics"
const ORANGE_CLASSES = "bg-orange-100 text-orange-700"
const library: Row[] = [
  { category: "INTRAOP_INFUSION", labelEn: "Remifentanil", labelBg: "Ремифентанил", group: OPIOIDS, color: "#ec4899" },
  { category: "INTRAOP_DRUG", labelEn: "Fentanyl", labelBg: "Фентанил", group: OPIOIDS, color: ORANGE_CLASSES },
  { category: "INTRAOP_INFUSION", labelEn: "Fentanyl", labelBg: "Фентанил", group: OPIOIDS, color: "#f97316" },
  { category: "INTRAOP_INFUSION", labelEn: "Dobutamine", labelBg: "Добутамин", group: "Vasoactive drugs - inotropes / inodilators", color: "#06b6d4" },
]

describe("drug colours for Status", () => {
  it("lists each drug once, by group, with its bolus and infusion together", async () => {
    const view = await drugColorsView(fakeDb(library, [{ scope: "DRUG", name: "Fentanyl", color: "#3b82f6" }]))
    expect(view.palette).toHaveLength(32)
    const opioids = view.groups.find(group => group.name === OPIOIDS)!
    expect(opioids.labelBg).toBe("Опиоидни аналгетици")
    expect(opioids.bundledColor).toBe("#f97316")
    expect(opioids.drugs.map(drug => [drug.name, drug.bolus, drug.infusion, drug.color])).toEqual([
      ["Fentanyl", true, true, "#3b82f6"],
      ["Remifentanil", false, true, null],
    ])
    // An infusion-only drug keeps its own bundled colour.
    expect(opioids.drugs[1].bundledColor).toBe("#ec4899")
  })

  it("sets, replaces and clears a colour", async () => {
    const db = fakeDb(library)
    expect(await setDrugColor(db, { scope: "GROUP", name: OPIOIDS, color: "#22C55E" })).toEqual({ groups: { [OPIOIDS]: "#22c55e" }, drugs: {} })
    expect((await setDrugColor(db, { scope: "GROUP", name: OPIOIDS, color: "#ef4444" })).groups[OPIOIDS]).toBe("#ef4444")
    expect(await setDrugColor(db, { scope: "GROUP", name: OPIOIDS, color: null })).toEqual({ groups: {}, drugs: {} })
  })

  it("refuses a colour that is not one, and a drug not in the library", async () => {
    const db = fakeDb(library)
    await expect(setDrugColor(db, { scope: "DRUG", name: "Fentanyl", color: "pink" })).rejects.toEqual(new DrugColorError("DRUG_COLOR_INVALID"))
    await expect(setDrugColor(db, { scope: "DRUG", name: "Nonexistium", color: "#123456" })).rejects.toEqual(new DrugColorError("DRUG_COLOR_TARGET_NOT_FOUND"))
    expect(db.drugColor.upsert).not.toHaveBeenCalled()
  })
})
