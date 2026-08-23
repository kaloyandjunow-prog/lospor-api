import { NextRequest, NextResponse } from "next/server"
import { corsHeaders } from "@/lib/cors"
import { z } from "zod"

const CORS = (req: NextRequest) => corsHeaders(req)
const localeSchema = z.enum(["bg", "en"])

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: CORS(req) })
}

export async function GET(req: NextRequest) {
  // Installation/device context only. Native clients use this before login;
  // authenticated account locale remains User.preferences.ui.locale and is
  // never changed by this read.
  const parsed = localeSchema.safeParse(process.env.LOSPOR_DEFAULT_LOCALE)
  return NextResponse.json(
    { locale: parsed.success ? parsed.data : "bg" },
    { headers: CORS(req) },
  )
}

export async function POST(req: NextRequest) {
  const parsed = z.object({ locale: localeSchema }).strict()
    .safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: "locale must be bg or en", code: "INVALID_LOCALE" }, { status: 400 })
  }
  // Pre-auth device/browser choice only. Explicit login `locale` or the
  // authenticated /v1/user preferences patch persists the account preference.
  const res = NextResponse.json({ locale: parsed.data.locale }, { headers: CORS(req) })
  res.cookies.set("locale", parsed.data.locale, { path: "/", maxAge: 60 * 60 * 24 * 365 })
  return res
}
