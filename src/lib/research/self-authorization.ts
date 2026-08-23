export const RESEARCH_SELF_AUTHORIZATION_HOURS = 8
export const RESEARCH_SELF_AUTHORIZATION_COOLDOWN_HOURS = 24

export function researchSelfAuthorizationStatus(
  lastIssuedAt: Date | null,
  now = new Date(),
): { eligible: boolean; nextEligibleAt: Date } {
  if (!lastIssuedAt) return { eligible: true, nextEligibleAt: now }
  const nextEligibleAt = new Date(
    lastIssuedAt.getTime() + RESEARCH_SELF_AUTHORIZATION_COOLDOWN_HOURS * 3_600_000,
  )
  return { eligible: nextEligibleAt.getTime() <= now.getTime(), nextEligibleAt }
}

export function researchSelfAuthorizationExpiry(now = new Date()): Date {
  return new Date(now.getTime() + RESEARCH_SELF_AUTHORIZATION_HOURS * 3_600_000)
}
