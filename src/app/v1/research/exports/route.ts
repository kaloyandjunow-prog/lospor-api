import { NextResponse, after } from "next/server"
import { logAudit } from "@/lib/audit"
import { authorizeResearchRequest, researchRouteError } from "@/lib/research/request"
import { researchExportCreateSchema } from "@/lib/research/schemas"
import {
  createResearchExport,
  listResearchExports,
  processResearchExport,
} from "@/lib/research/exports"

export async function GET(request: Request) {
  const auth = await authorizeResearchRequest(request, "export")
  if ("response" in auth) return auth.response
  try {
    return NextResponse.json(await listResearchExports(auth.context))
  } catch (error) {
    return researchRouteError(error)
  }
}

export async function POST(request: Request) {
  const auth = await authorizeResearchRequest(request, "export")
  if ("response" in auth) return auth.response
  try {
    const parsed = researchExportCreateSchema.safeParse(await request.json())
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid research export", code: "INVALID_RESEARCH_EXPORT", details: parsed.error.flatten() },
        { status: 400 },
      )
    }
    if (
      (parsed.data.format === "omop-csv" || parsed.data.format === "omop-json") &&
      !auth.context.permissions.exportOmop
    ) {
      return NextResponse.json(
        { error: "OMOP export permission is required", code: "OMOP_EXPORT_FORBIDDEN" },
        { status: 403 },
      )
    }
    const record = await createResearchExport(auth.context, parsed.data)
    after(() => logAudit(auth.context.user.id, "RESEARCH_EXPORT_CREATE", record.id, {
      format: record.format,
    }))
    after(() => processResearchExport(record.id).catch(error => {
      console.error("[LOSPOR] research export generation failed", error)
    }))
    return NextResponse.json(record, { status: 202 })
  } catch (error) {
    return researchRouteError(error)
  }
}

export const maxDuration = 300
