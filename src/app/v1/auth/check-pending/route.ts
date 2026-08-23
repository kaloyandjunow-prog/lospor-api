import { NextResponse } from "next/server"

/**
 * Removed approval-queue compatibility endpoint.
 *
 * Older clients may still call it after registration. Returning an explicit
 * constant false avoids account enumeration and tells them there is no second
 * activation state; email verification is the only activation gate.
 */
export async function GET() {
  return NextResponse.json({ pending: false, deprecated: true })
}
