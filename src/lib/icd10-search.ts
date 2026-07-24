export type Icd10SearchRow = {
  code: string
  labelEn: string
  labelBg?: string | null
}

export type Icd10SearchResult = {
  code: string
  description: string
  descriptionBg?: string
  display: string
  system: "ICD-10"
}

export function isIcd10CodeLikeQuery(query: string): boolean {
  return /^[A-TV-Z][0-9]/i.test(query.trim())
}

export function formatIcd10Result(row: Icd10SearchRow, useBg: boolean): Icd10SearchResult {
  const labelBg = row.labelBg?.trim() || undefined
  const label = useBg && labelBg ? labelBg : row.labelEn
  return {
    code: row.code,
    description: row.labelEn,
    ...(labelBg ? { descriptionBg: labelBg } : {}),
    display: `${row.code} - ${label}`,
    system: "ICD-10",
  }
}

export function mergeIcd10Results(groups: Icd10SearchRow[][], useBg: boolean, limit = 20): Icd10SearchResult[] {
  const seen = new Set<string>()
  const results: Icd10SearchResult[] = []

  for (const group of groups) {
    for (const row of group) {
      if (seen.has(row.code)) continue
      seen.add(row.code)
      results.push(formatIcd10Result(row, useBg))
      if (results.length >= limit) return results
    }
  }

  return results
}
