/**
 * RFC 4180 quoting plus spreadsheet-formula neutralisation, for every CSV this
 * service emits.
 *
 * The security case — a crafted cell executing something when the file is opened
 * — is the exotic one. The case that actually occurs in a clinical register is
 * mundane: notes frequently begin with a dash ("- no allergies", "-ve pressure
 * ventilation"), and a spreadsheet reads a leading dash as arithmetic, showing
 * #NAME? in place of the text. The exported value then no longer matches the
 * record, which defeats the purpose of a research export.
 *
 * A leading apostrophe marks the cell as text in every major spreadsheet; it is
 * stripped on import and is not shown in the cell.
 */
const FORMULA_LEADERS = new Set(["=", "+", "-", "@", "\t", "\r"])

export function neutraliseFormula(text: string): string {
  return text.length > 0 && FORMULA_LEADERS.has(text[0]) ? `'${text}` : text
}

export function csvCell(value: unknown): string {
  if (value == null) return ""
  const text = neutraliseFormula(Array.isArray(value) ? value.join(" | ") : String(value))
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}
