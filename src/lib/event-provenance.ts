import type { AuthSessionClient } from "@/lib/auth-sessions"

export type ClinicalEventSource = "web" | "mobile"

/**
 * Event provenance comes from the server-issued authentication session, not
 * a write-request header a caller could change for each event.
 *
 * The conservative fallback keeps old/mocked users on Web. Real 1.2.0
 * sessions always carry one of the three explicit client types.
 */
export function clinicalEventSource(
  user: { clientType?: AuthSessionClient | null },
): ClinicalEventSource {
  return user.clientType === "PWA" || user.clientType === "NATIVE"
    ? "mobile"
    : "web"
}
