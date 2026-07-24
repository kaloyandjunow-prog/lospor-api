const STATE_CHANGING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"])

type HeaderSource = { headers: { get(name: string): string | null }; method: string }

function originFrom(raw: string | null): string | null {
  if (!raw) return null
  try { return new URL(raw).origin } catch { return null }
}

export function appOrigin(): string | null {
  const raw =
    process.env.LOSPOR_WEB_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.NEXTAUTH_URL ??
    null
  if (raw) return originFrom(raw)
  if (process.env.VERCEL_URL) return originFrom(`https://${process.env.VERCEL_URL}`)
  return null
}

export function usesBearerAuth(req: HeaderSource): boolean {
  return (req.headers.get("authorization") ?? "").startsWith("Bearer ")
}

export function isStateChangingMethod(method: string): boolean {
  return STATE_CHANGING_METHODS.has(method.toUpperCase())
}

export function validateCookieWriteOrigin(req: HeaderSource): "pass" | "skip" | "fail" {
  if (!isStateChangingMethod(req.method)) return "pass"
  if (usesBearerAuth(req)) return "pass"

  const expected = appOrigin()
  if (!expected) return "skip"

  const origin = originFrom(req.headers.get("origin"))
  if (origin) return origin === expected ? "pass" : "fail"

  const referer = originFrom(req.headers.get("referer"))
  return referer === expected ? "pass" : "fail"
}
