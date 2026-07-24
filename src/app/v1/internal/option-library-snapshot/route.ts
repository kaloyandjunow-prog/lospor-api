import { NextRequest, NextResponse } from "next/server"
// Static import (not a runtime fs.readFileSync) so Vercel's serverless
// function file-tracing always bundles this JSON alongside the route,
// regardless of how its dependency-tracing handles dynamic file reads.
import { BUNDLED_CATALOG_SNAPSHOT } from "@lospor/core/catalog"

// Serves the option-library fallback snapshot that THIS deployment's build
// generated (npm run build → gen:option-library-fallback, see package.json)
// — not a fresh DB query, just the file already bundled into this build.
//
// Exists so lospor-mobile's EAS prebuild hook can fetch a fresh snapshot
// before bundling, without EAS needing direct database/Prisma access (it
// can't reach lospor-app's repo/DB at all — separate repo, separate build
// environment). Gated by a shared secret rather than left open: the data
// itself isn't sensitive (no PHI, just pick-list option labels/codes), but
// an unauthenticated "fetch anything" endpoint is still worth locking down
// as a matter of habit.
export async function GET(req: NextRequest) {
  const secret = process.env.OPTION_LIBRARY_SNAPSHOT_SECRET
  if (!secret) {
    return NextResponse.json({ error: "Not configured" }, { status: 503 })
  }
  if (req.headers.get("x-snapshot-secret") !== secret) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  return NextResponse.json(BUNDLED_CATALOG_SNAPSHOT)
}
