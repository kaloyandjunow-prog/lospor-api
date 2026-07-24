import "server-only"
import { jwtVerify } from "jose"
import { isRevokedAsync } from "@/lib/token-blocklist"

function secret() {
  const value = process.env.LOSPOR_AUTH_SECRET ?? process.env.NEXTAUTH_SECRET
  if (!value) throw new Error("LOSPOR_AUTH_SECRET or NEXTAUTH_SECRET is required")
  return new TextEncoder().encode(value)
}

export async function verifyPrintToken(token: string, caseId: string) {
  try {
    const { payload } = await jwtVerify(token, secret())
    if (payload.type !== "print" || payload.caseId !== caseId) return null
    const jti = payload.jti as string | undefined
    if (jti && await isRevokedAsync(jti)) return null
    return (payload.userId as string) ?? null
  } catch {
    return null
  }
}
