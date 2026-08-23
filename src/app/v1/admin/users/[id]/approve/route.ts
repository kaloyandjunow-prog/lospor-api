import { NextRequest, NextResponse } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { requireRole } from "@/lib/access-control"

/** Compatibility tombstone: public accounts activate by email verification. */
export async function POST(request: NextRequest) {
  const user = await getAuthUser(request)
  if (!requireRole(user, ["ADMIN"])) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  return NextResponse.json({
    error: "Account approval is no longer a separate state",
    code: "ACCOUNT_APPROVAL_NOT_SUPPORTED",
  }, { status: 410 })
}
