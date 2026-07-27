import { NextResponse, after } from "next/server"
import { logAudit } from "@/lib/audit"
import { authorizeResearchRequest, researchRouteError } from "@/lib/research/request"
import {
  openResearchExport,
  ResearchExportError,
} from "@/lib/research/exports"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authorizeResearchRequest(request, "export")
  if ("response" in auth) return auth.response
  try {
    const { id } = await params
    const result = await openResearchExport(auth.context, id)
    after(() => logAudit(auth.context.user.id, "RESEARCH_EXPORT_DOWNLOAD", id, {
      format: result.record.format,
      rowCount: result.record.rowCount,
      checksum: result.record.checksum,
    }))
    return new NextResponse(result.stream, {
      headers: {
        "Content-Type": result.contentType,
        "Content-Disposition": `attachment; filename="${result.filename}"`,
        "X-Content-Type-Options": "nosniff",
        "X-LOSPOR-Export-Complete": "true",
        "X-LOSPOR-Export-Rows": String(result.record.rowCount ?? 0),
        ...(result.contentLength !== null
          ? { "Content-Length": String(result.contentLength) }
          : {}),
        ...(result.record.asOf
          ? { "X-LOSPOR-Export-As-Of": result.record.asOf }
          : {}),
        ...(result.record.snapshotHash
          ? { "X-LOSPOR-Export-Snapshot-SHA256": result.record.snapshotHash }
          : {}),
        ...(result.record.checksum
          ? { "X-LOSPOR-Export-SHA256": result.record.checksum }
          : {}),
      },
    })
  } catch (error) {
    if (error instanceof ResearchExportError) {
      return NextResponse.json({
        error: error.message,
        code: error.code,
      }, { status: error.status })
    }
    return researchRouteError(error)
  }
}
