export function normalizeIdentityPart(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

export function buildDisplayName(input: {
  title: string
  firstName: string
  lastName: string
}): string {
  return [input.title, input.firstName, input.lastName]
    .map(normalizeIdentityPart)
    .filter(Boolean)
    .join(" ")
}
