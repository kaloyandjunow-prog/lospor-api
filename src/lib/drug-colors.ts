import type { Prisma, PrismaClient } from "@/generated/prisma/client"
import { clinicalDisplayLabel } from "@lospor/core/display"
import {
  bundledColorHex,
  DRUG_COLOR_PALETTE,
  normalizeDrugColor,
  resolveDrugColor,
  type DrugColorMap,
  type DrugColorScope,
} from "@lospor/core/drug-colors"

/**
 * A hospital's own drug colours (10.0.0): read for the option library, and
 * listed and changed for Status. A colour is keyed by the group or the drug's
 * English label, so a drug's bolus and its infusion share it.
 */

type Db = PrismaClient | Prisma.TransactionClient

/** The categories whose options are drawn in the drug colours. */
export const DRUG_COLOR_CATEGORIES = ["INTRAOP_DRUG", "INTRAOP_INFUSION"] as const

export class DrugColorError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

export async function readDrugColors(db: Db): Promise<DrugColorMap> {
  const rows = await db.drugColor.findMany()
  const groups: Record<string, string> = {}
  const drugs: Record<string, string> = {}
  for (const row of rows) {
    const color = normalizeDrugColor(row.color)
    if (!color) continue
    if (row.scope === "GROUP") groups[row.name] = color
    else if (row.scope === "DRUG") drugs[row.name] = color
  }
  return { groups, drugs }
}

/**
 * An option's hospital colour, and its group's for the menus' group headers;
 * nothing where the bundled colour applies.
 */
export function customColorFor(colors: DrugColorMap, option: { group: string | null; labelEn: string }): { customColor?: string; customGroupColor?: string } {
  const color = resolveDrugColor(colors, option.group, option.labelEn)
  const groupColor = option.group ? colors.groups[option.group] : undefined
  return { ...(color ? { customColor: color } : {}), ...(groupColor ? { customGroupColor: groupColor } : {}) }
}

export type DrugColorDrugView = {
  name: string
  labelBg: string | null
  /** The colour it is drawn in when nothing is chosen for it or its group. */
  bundledColor: string
  /** Its own colour, if one was chosen. */
  color: string | null
  bolus: boolean
  infusion: boolean
}

export type DrugColorGroupView = {
  name: string
  labelEn: string
  labelBg: string
  bundledColor: string
  color: string | null
  drugs: DrugColorDrugView[]
}

export type DrugColorsView = {
  palette: { hex: string; labelEn: string; labelBg: string }[]
  groups: DrugColorGroupView[]
}

const FALLBACK = "#64748b"

/**
 * Every drug and infusion in the library, by group, in the menus' order, with
 * the colours chosen and the bundled ones. Status has no Core of its own, so
 * the palette travels with it.
 */
export async function drugColorsView(db: Db): Promise<DrugColorsView> {
  const [options, colors] = await Promise.all([
    db.optionLibrary.findMany({
      where: { category: { in: [...DRUG_COLOR_CATEGORIES] }, active: true },
      orderBy: [{ sortOrder: "asc" }],
      select: { category: true, labelEn: true, labelBg: true, group: true, color: true },
    }),
    readDrugColors(db),
  ])
  const groups = new Map<string, DrugColorGroupView>()
  const drugs = new Map<string, DrugColorDrugView>()
  // Bolus drugs first: a group takes its colour from its first drug, as the menus do.
  const ordered = [...options].sort((left, right) => (left.category === right.category ? 0 : left.category === "INTRAOP_DRUG" ? -1 : 1))
  for (const option of ordered) {
    const groupName = option.group ?? "Other"
    let group = groups.get(groupName)
    if (!group) {
      group = {
        name: groupName,
        labelEn: clinicalDisplayLabel("optionGroup", groupName, "en", { label: groupName }),
        labelBg: clinicalDisplayLabel("optionGroup", groupName, "bg", { label: groupName }),
        bundledColor: bundledColorHex(option.color) ?? FALLBACK,
        color: colors.groups[groupName] ?? null,
        drugs: [],
      }
      groups.set(groupName, group)
    }
    const existing = drugs.get(option.labelEn)
    if (existing) {
      if (option.category === "INTRAOP_DRUG") existing.bolus = true
      else existing.infusion = true
      continue
    }
    const drug: DrugColorDrugView = {
      name: option.labelEn,
      labelBg: option.labelBg,
      // A bolus drug is drawn in its group's colour; an infusion-only drug in its own.
      bundledColor: option.category === "INTRAOP_DRUG" ? group.bundledColor : bundledColorHex(option.color) ?? group.bundledColor,
      color: colors.drugs[option.labelEn] ?? null,
      bolus: option.category === "INTRAOP_DRUG",
      infusion: option.category === "INTRAOP_INFUSION",
    }
    drugs.set(option.labelEn, drug)
    group.drugs.push(drug)
  }
  for (const group of groups.values()) group.drugs.sort((left, right) => left.name.localeCompare(right.name))
  return {
    palette: DRUG_COLOR_PALETTE.map(color => ({ ...color })),
    groups: [...groups.values()],
  }
}

export type DrugColorChange = { scope: DrugColorScope; name: string; color: string | null }

/**
 * Sets one group's or one drug's colour, or clears it (null) so the group's
 * or the bundled colour applies again. The name must be in the library.
 */
export async function setDrugColor(db: Db, change: DrugColorChange): Promise<DrugColorMap> {
  const name = change.name.trim()
  if (!name || name.length > 200) throw new DrugColorError("DRUG_COLOR_INVALID")
  const color = change.color === null ? null : normalizeDrugColor(change.color)
  if (change.color !== null && !color) throw new DrugColorError("DRUG_COLOR_INVALID")
  const known = await db.optionLibrary.count({
    where: {
      category: { in: [...DRUG_COLOR_CATEGORIES] },
      active: true,
      ...(change.scope === "GROUP" ? { group: name } : { labelEn: name }),
    },
  })
  if (!known) throw new DrugColorError("DRUG_COLOR_TARGET_NOT_FOUND")
  if (color) {
    await db.drugColor.upsert({
      where: { scope_name: { scope: change.scope, name } },
      create: { scope: change.scope, name, color },
      update: { color },
    })
  } else {
    await db.drugColor.deleteMany({ where: { scope: change.scope, name } })
  }
  return readDrugColors(db)
}
