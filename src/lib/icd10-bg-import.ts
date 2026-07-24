export type Icd10BgLabel = {
  code: string
  labelBg: string
}

const ICD10_CODE = /^[A-Z][0-9]{2}(?:\.[0-9A-Z]+)?$/

function cellText(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value).trim()
    : ""
}

function findColumn(headers: unknown[], patterns: RegExp[], fallback: number): number {
  const index = headers.findIndex((value) => {
    const header = cellText(value)
    return patterns.some((pattern) => pattern.test(header))
  })
  return index >= 0 ? index : fallback
}

export function parseIcd10BgRows(rows: unknown[][]): Icd10BgLabel[] {
  if (rows.length < 2) return []

  const headers = rows[0]
  const codeColumn = findColumn(headers, [/^code$/i, /^icd/i, /^код$/i, /^шифър$/i], 0)
  const labelColumn = findColumn(
    headers,
    [/label/i, /description/i, /name/i, /наименование/i, /описание/i],
    codeColumn === 0 ? 1 : 0,
  )
  const labels = new Map<string, string>()

  for (const row of rows.slice(1)) {
    const code = cellText(row[codeColumn]).toUpperCase()
    const labelBg = cellText(row[labelColumn])
    if (!ICD10_CODE.test(code) || !labelBg) continue
    labels.set(code, labelBg)
  }

  return [...labels].map(([code, labelBg]) => ({ code, labelBg }))
}
