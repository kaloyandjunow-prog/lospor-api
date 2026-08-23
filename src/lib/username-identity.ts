export const USERNAME_MIN_LENGTH = 3
export const USERNAME_MAX_LENGTH = 64

export type NormalizedUsername = {
  username: string
  usernameCanonical: string
}

export type UsernameValidationCode =
  | "USERNAME_REQUIRED"
  | "USERNAME_LENGTH"
  | "USERNAME_FORMAT"

export type UsernameValidationResult =
  | { success: true; value: NormalizedUsername }
  | { success: false; code: UsernameValidationCode }

/** Return the exact case-preserving spelling that will be stored. */
export function normalizeUsernameDisplay(value: string): string {
  return value
}

/** The only database/login comparison key for Hospital usernames. */
export function canonicalizeUsername(value: string): string {
  return value.toLowerCase()
}

export function validateAndNormalizeUsername(input: unknown): UsernameValidationResult {
  if (typeof input !== "string") return { success: false, code: "USERNAME_REQUIRED" }
  const username = input
  if (username.length < USERNAME_MIN_LENGTH || username.length > USERNAME_MAX_LENGTH) {
    return { success: false, code: "USERNAME_LENGTH" }
  }
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(username)) {
    return { success: false, code: "USERNAME_FORMAT" }
  }
  const usernameCanonical = username.toLowerCase()
  return { success: true, value: { username, usernameCanonical } }
}

export function normalizeRequiredUsername(input: unknown): NormalizedUsername {
  const result = validateAndNormalizeUsername(input)
  if (!result.success) throw new Error(result.code)
  return result.value
}
