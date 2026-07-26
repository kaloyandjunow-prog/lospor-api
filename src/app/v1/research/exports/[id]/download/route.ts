import { NextResponse, after } from "next/server"
import { logAudit } from "@/lib/audit"
import { authorizeResearchRequest, researchRouteError } from "@/lib/research/request"
import {
  generateResearchExport,
  ResearchExportQualityError,
} from "@/lib/research/exports"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authorizeResearchRequest(request, "export")
  if ("response" in auth) return auth.response
  try {
    const { id } = await params
    const result = await generateResearchExport(auth.context, id)
    after(() => logAudit(auth.context.user.id, "RESEARCH_EXPORT_DOWNLOAD", id, {
      format: result.record.format,
      rowCount: result.record.rowCount,
      checksum: result.record.checksum,
    }))
    return new NextResponse(result.body, {
      headers: {
        "Content-Type": result.contentType,
        "Content-Disposition": `attachment; filename="${result.filename}"`,
        "X-Content-Type-Options": "nosniff",
        "X-LOSPOR-Export-Complete": "true",
        "X-LOSPOR-Export-Rows": String(result.record.rowCount ?? 0),
        ...(result.record.checksum
          ? { "X-LOSPOR-Export-SHA256": result.record.checksum }
          : {}),
      },
    })
  } catch (error) {
    if (error instanceof ResearchExportQualityError) {
      return NextResponse.json({
        error: error.message,
        code: "RESEARCH_EXPORT_QUALITY_FAILED",
        warnings: error.warnings,
      }, { status: 422 })
    }
    if (error instanceof Error && error.message === "EXPORT_NOT_FOUND") {
      return NextResponse.json({ error: "Export not found" }, { status: 404 })
    }
    if (error instanceof Error && error.message === "OMOP_EXPORT_FORBIDDEN") {
      return NextResponse.json({ error: "OMOP export permission is required" }, { status: 403 })
    }
    return researchRouteError(error)
  }
}
