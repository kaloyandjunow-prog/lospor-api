export const RESEARCH_GRANT_DEFAULT_DAYS = 90
export const RESEARCH_GRANT_MAX_DAYS = 365

export class ResearchGrantPolicyError extends Error {
  constructor(
    readonly code: "RESEARCH_GRANT_EXPIRY_PAST" | "RESEARCH_GRANT_EXPIRY_TOO_LONG",
    message: string,
  ) {
    super(message)
  }
}

export function researchGrantExpiry(
  requested: string | undefined,
  now = new Date(),
  issuedAt = now,
): Date {
  const expiresAt = requested
    ? new Date(requested)
    : new Date(now.getTime() + RESEARCH_GRANT_DEFAULT_DAYS * 86_400_000)
  if (expiresAt.getTime() <= now.getTime()) {
    throw new ResearchGrantPolicyError(
      "RESEARCH_GRANT_EXPIRY_PAST",
      "Research grant expiry must be in the future",
    )
  }
  const maximum = issuedAt.getTime() + RESEARCH_GRANT_MAX_DAYS * 86_400_000
  if (expiresAt.getTime() > maximum) {
    throw new ResearchGrantPolicyError(
      "RESEARCH_GRANT_EXPIRY_TOO_LONG",
      `Research grants cannot exceed ${RESEARCH_GRANT_MAX_DAYS} days`,
    )
  }
  return expiresAt
}
