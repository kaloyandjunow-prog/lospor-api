import { NextRequest, NextResponse } from "next/server"
import { getAuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"
import { corsHeaders } from "@/lib/cors"
import { CASE_LOCK_TTL_MS } from "@lospor/core/sync"

// ---------------------------------------------------------------------------
// Helper — resolve case ownership (same pattern as [id]/route.ts)
// Returns the case status string if found and allowed, or a NextResponse error.
// ---------------------------------------------------------------------------
async function resolveCase(
  req: NextRequest,
  id: string,
): Promise<{ userId: string; status: string } | NextResponse> {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const existing = await prisma.case.findUnique({
    where: { id },
    select: {
      userId: true,
      status: true,
      user: { select: { institutionId: true } },
    },
  })
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 })

  const isAdmin = user.role === "ADMIN"
  const isHOD =
    user.role === "HEAD_OF_DEPT" &&
    !!user.institutionId &&
    existing.user?.institutionId === user.institutionId
  if (existing.userId !== user.id && !isAdmin && !isHOD)
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  return { userId: user.id, status: existing.status }
}

const CORS = (req: NextRequest) => corsHeaders(req)

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: CORS(req) })
}

// ---------------------------------------------------------------------------
// POST /api/cases/[id]/lock — acquire lock
// Body: { deviceId: string }
// ---------------------------------------------------------------------------
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const resolved = await resolveCase(req, id)
  if (resolved instanceof NextResponse) return resolved
  const { userId, status } = resolved

  // COMPLETE cases need no locking
  if (status === "COMPLETE") {
    return NextResponse.json({ acquired: true, locked: false, yours: true })
  }

  const body: { deviceId?: string } = await req.json().catch(() => ({}))
  const deviceId = typeof body.deviceId === "string" ? body.deviceId : ""

  const now = new Date()
  const expiresAt = new Date(now.getTime() + CASE_LOCK_TTL_MS)

  const existing = await prisma.caseLock.findUnique({ where: { caseId: id } })

  if (existing && existing.expiresAt > now) {
    // Active lock held by someone
    if (existing.userId === userId && existing.deviceId === deviceId) {
      // The lock may be released between the read and write. updateMany keeps
      // this path idempotent instead of throwing P2025 during that race.
      const refreshed = await prisma.caseLock.updateMany({
        where: { caseId: id, userId, deviceId },
        data: { expiresAt },
      })
      if (refreshed.count > 0) {
        return NextResponse.json({ acquired: true, locked: false, yours: true })
      }
      await prisma.caseLock.upsert({
        where: { caseId: id },
        create: { caseId: id, userId, deviceId, expiresAt },
        update: { userId, deviceId, expiresAt },
      })
      return NextResponse.json({ acquired: true, locked: false, yours: true })
    }
    // Different device/user holds the lock — look up holder name for the watching banner
    let holderName: string | null = null
    try {
      const holder = await prisma.user.findUnique({
        where: { id: existing.userId },
        select: { name: true, email: true },
      })
      holderName = holder?.name ?? holder?.email ?? null
    } catch {}
    return NextResponse.json({
      acquired: false,
      locked: true,
      holder: { holderName },
      holderName,
    }, { status: 409 })
  }

  // No lock or expired lock — upsert
  await prisma.caseLock.upsert({
    where: { caseId: id },
    create: { caseId: id, userId, deviceId, expiresAt },
    update: { userId, deviceId, expiresAt },
  })
  return NextResponse.json({ acquired: true, locked: false })
}

// ---------------------------------------------------------------------------
// PATCH /api/cases/[id]/lock — heartbeat (extend TTL)
// Body: { deviceId: string }
// ---------------------------------------------------------------------------
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const resolved = await resolveCase(req, id)
  if (resolved instanceof NextResponse) return resolved
  const { userId } = resolved

  const body: { deviceId?: string } = await req.json().catch(() => ({}))
  const deviceId = typeof body.deviceId === "string" ? body.deviceId : ""

  const now = new Date()
  const expiresAt = new Date(now.getTime() + CASE_LOCK_TTL_MS)

  const existing = await prisma.caseLock.findUnique({ where: { caseId: id } })

  if (existing && existing.expiresAt > now && (existing.userId !== userId || existing.deviceId !== deviceId)) {
    // A different device/user actively holds an unexpired lock — genuine conflict.
    return NextResponse.json({ acquired: false, locked: true, extended: false }, { status: 409 })
  }

  // Either we already hold it, or it's expired/missing — safe to (re)claim.
  // updateMany first keeps this idempotent; if the row was deleted/replaced
  // between the read and write (same momentary-mismatch race POST already
  // guards against), fall back to upsert instead of spuriously 409ing the
  // heartbeat, which previously disabled the whole editing form.
  const refreshed = await prisma.caseLock.updateMany({
    where: { caseId: id, userId, deviceId },
    data: { expiresAt },
  })
  if (refreshed.count > 0) {
    return NextResponse.json({ acquired: true, locked: false, extended: true })
  }
  await prisma.caseLock.upsert({
    where: { caseId: id },
    create: { caseId: id, userId, deviceId, expiresAt },
    update: { userId, deviceId, expiresAt },
  })
  return NextResponse.json({ acquired: true, locked: false, extended: true })
}

// ---------------------------------------------------------------------------
// DELETE /api/cases/[id]/lock — release lock (idempotent)
// Body: { deviceId: string } — release own lock
// Body: { force: true }      — force-release any lock on this case (own cases only)
// ---------------------------------------------------------------------------
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const resolved = await resolveCase(req, id)
  if (resolved instanceof NextResponse) return resolved
  const { userId } = resolved

  const body: { deviceId?: string; force?: boolean } = await req.json().catch(() => ({}))

  if (body.force === true) {
    // Force-takeover: delete any lock on this case. resolveCase() has already
    // authorized the caller for this case (owner, admin, or same-institution HOD),
    // so an admin/HOD editing someone else's case can clear a stale lock too —
    // previously only the literal owner could, leaving them stuck behind it.
    await prisma.caseLock.deleteMany({ where: { caseId: id } })
    return NextResponse.json({ released: true, forced: true })
  }

  const deviceId = typeof body.deviceId === "string" ? body.deviceId : ""
  await prisma.caseLock.deleteMany({ where: { caseId: id, userId, deviceId } })

  // Always 200 — idempotent
  return NextResponse.json({ released: true })
}
