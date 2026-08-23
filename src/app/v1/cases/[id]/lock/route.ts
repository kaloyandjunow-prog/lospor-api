import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { CASE_LOCK_TTL_MS } from "@lospor/core/sync"
import { acquireCaseLockAtomic, readCaseLock } from "@/lib/case-lock-repository"
import { corsHeaders } from "@/lib/cors"
import { getAuthUser } from "@/lib/mobile-auth"
import { prisma } from "@/lib/prisma"
import { caseWriteWhereForUser } from "@/lib/access-control"

const lockBodySchema = z.object({
  deviceId: z.string().trim().min(1).max(256),
})

async function resolveCase(
  req: NextRequest,
  id: string,
): Promise<{ userId: string; status: string } | NextResponse> {
  const user = await getAuthUser(req)
  if (!user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const existing = await prisma.case.findFirst({
    where: caseWriteWhereForUser(user, id),
    select: { status: true },
  })
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 })

  return { userId: user.id, status: existing.status }
}

function invalidDeviceId() {
  return NextResponse.json(
    { error: "A non-empty deviceId is required", code: "INVALID_DEVICE_ID" },
    { status: 400 },
  )
}

async function parseDeviceId(req: NextRequest): Promise<string | null> {
  const parsed = lockBodySchema.safeParse(await req.json().catch(() => null))
  return parsed.success ? parsed.data.deviceId : null
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req) })
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const resolved = await resolveCase(req, id)
  if (resolved instanceof NextResponse) return resolved
  const { userId, status } = resolved

  if (status === "COMPLETE") {
    return NextResponse.json({ acquired: true, locked: false, yours: true })
  }

  const deviceId = await parseDeviceId(req)
  if (!deviceId) return invalidDeviceId()

  const input = { caseId: id, userId, deviceId, ttlMs: CASE_LOCK_TTL_MS }
  const acquired = await acquireCaseLockAtomic(input)
  if (acquired) {
    return NextResponse.json({ acquired: true, locked: false, yours: true })
  }

  let existing = await readCaseLock(id)
  // A release may win immediately after the failed compare-and-set.
  if (!existing || existing.expiresAt <= new Date()) {
    const retried = await acquireCaseLockAtomic(input)
    if (retried) {
      return NextResponse.json({ acquired: true, locked: false, yours: true })
    }
    existing = await readCaseLock(id)
  }

  let holderName: string | null = null
  if (existing) {
    try {
      const holder = await prisma.user.findUnique({
        where: { id: existing.userId },
        select: { name: true, username: true, email: true },
      })
      holderName = holder?.name ?? holder?.username ?? holder?.email ?? null
    } catch {}
  }
  return NextResponse.json({
    acquired: false,
    locked: true,
    holder: { holderName },
    holderName,
  }, { status: 409 })
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const resolved = await resolveCase(req, id)
  if (resolved instanceof NextResponse) return resolved

  const deviceId = await parseDeviceId(req)
  if (!deviceId) return invalidDeviceId()

  const acquired = await acquireCaseLockAtomic({
    caseId: id,
    userId: resolved.userId,
    deviceId,
    ttlMs: CASE_LOCK_TTL_MS,
  })
  if (acquired) {
    return NextResponse.json({ acquired: true, locked: false, extended: true })
  }
  return NextResponse.json(
    { acquired: false, locked: true, extended: false },
    { status: 409 },
  )
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const resolved = await resolveCase(req, id)
  if (resolved instanceof NextResponse) return resolved

  const body: { deviceId?: string; force?: boolean } = await req.json().catch(() => ({}))
  if (body.force === true) {
    await prisma.caseLock.deleteMany({ where: { caseId: id } })
    return NextResponse.json({ released: true, forced: true })
  }

  const parsed = lockBodySchema.safeParse(body)
  if (!parsed.success) return invalidDeviceId()
  await prisma.caseLock.deleteMany({
    where: { caseId: id, userId: resolved.userId, deviceId: parsed.data.deviceId },
  })
  return NextResponse.json({ released: true })
}
