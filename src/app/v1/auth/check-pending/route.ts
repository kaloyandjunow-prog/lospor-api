import { NextRequest, NextResponse } from "next/server"
import { rateLimit } from "@/lib/rate-limit"

export async function GET(req: NextRequest) {
  const start = Date.now()
  const ip = req.headers.get("x-forwarded-for") ?? "unknown"
  const rl = await rateLimit(`check-pending:${ip}`, 20, 15 * 60 * 1000)
  if (!rl.allowed) {
    return NextResponse.json({ pending: false }, { status: 429, headers: { "Retry-After": String(rl.retryAfter) } })
  }

  // Constant-time floor: always respond after at least 200ms to prevent
  // timing-based enumeration and preserve the legacy response shape.
  const elapsed = Date.now() - start
  if (elapsed < 200) await new Promise(r => setTimeout(r, 200 - elapsed))

  return NextResponse.json({ pending: false })
}
