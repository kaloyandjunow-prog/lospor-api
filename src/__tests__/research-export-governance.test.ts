import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ResearchExportFormat } from "@lospor/core/research"

/**
 * Disclosure control on the research export routes.
 *
 * Two things are enforced here and were not covered anywhere. The first is the
 * OMOP gate: `omop-csv` and `omop-json` require a second, separately granted
 * permission, while `csv` and `json` need only the base export grant. A blanket
 * gate would be just as wrong as no gate — it would quietly withdraw ordinary
 * exports from everyone holding a plain export grant — so both directions are
 * asserted.
 *
 * The second is the audit trail. Every research route registers a `logAudit`
 * call through `after()`, and the claim that research access is fully audited
 * rests on those calls. Nothing verified they happen, or that a rejected
 * request stays out of the log. `after` is mocked to run its callback so the
 * registration is observable; this pins that the route asks for the audit row,
 * not that Next flushes it.
 */

const createExportMock = vi.fn()
const listExportsMock = vi.fn()
const processExportMock = vi.fn()
const openExportMock = vi.fn()
const authorizeMock = vi.fn()
const logAuditMock = vi.fn()

vi.mock("next/server", async importOriginal => ({
  ...(await importOriginal<typeof import("next/server")>()),
  // Run the callback inline. Outside a request scope Next drops it silently,
  // which would make every assertion below vacuously pass.
  after: (callback: () => unknown) => { callback() },
}))

vi.mock("@/lib/audit", () => ({ logAudit: logAuditMock }))

vi.mock("@/lib/research/request", () => ({
  authorizeResearchRequest: authorizeMock,
  researchRouteError: () => new Response(null, { status: 500 }),
}))

vi.mock("@/lib/research/exports", () => ({
  createResearchExport: createExportMock,
  listResearchExports: listExportsMock,
  processResearchExport: processExportMock,
  openResearchExport: openExportMock,
  ResearchExportError: class extends Error {},
}))

type Permissions = {
  query: boolean
  inspectCases: boolean
  export: boolean
  exportOmop: boolean
}

function grant(overrides: Partial<Permissions> = {}) {
  authorizeMock.mockResolvedValue({
    context: {
      user: { id: "researcher-1" },
      permissions: {
        query: true,
        inspectCases: true,
        export: true,
        exportOmop: false,
        ...overrides,
      },
    },
  })
}

function exportRequest(format: ResearchExportFormat) {
  return new Request("http://localhost/v1/research/exports", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "cohort export",
      format,
      definition: { filters: {} },
    }),
  })
}

let POST: (request: Request) => Promise<Response>
let DOWNLOAD: (
  request: Request,
  context: { params: Promise<{ id: string }> },
) => Promise<Response>

beforeEach(async () => {
  vi.clearAllMocks()
  vi.resetModules()
  grant()
  createExportMock.mockImplementation(async (_context, input) => ({
    id: "export-1",
    format: input.format,
  }))
  processExportMock.mockResolvedValue(null)
  ;({ POST } = await import("@/app/v1/research/exports/route"))
  ;({ GET: DOWNLOAD } = await import("@/app/v1/research/exports/[id]/download/route"))
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("OMOP export permission gate", () => {
  for (const format of ["omop-csv", "omop-json"] as const) {
    it(`refuses ${format} without the OMOP export permission`, async () => {
      const response = await POST(exportRequest(format))

      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ code: "OMOP_EXPORT_FORBIDDEN" })
      expect(createExportMock).not.toHaveBeenCalled()
    })
  }

  for (const format of ["csv", "json"] as const) {
    it(`allows ${format} on a plain export grant`, async () => {
      const response = await POST(exportRequest(format))

      expect(response.status).toBe(202)
      expect(createExportMock).toHaveBeenCalledTimes(1)
      expect(createExportMock.mock.calls[0][1]).toMatchObject({ format })
    })
  }

  it("allows OMOP once the second permission is granted", async () => {
    grant({ exportOmop: true })

    const response = await POST(exportRequest("omop-csv"))

    expect(response.status).toBe(202)
    expect(createExportMock).toHaveBeenCalledTimes(1)
  })
})

describe("research export audit trail", () => {
  it("records the created export with its format", async () => {
    await POST(exportRequest("csv"))

    expect(logAuditMock).toHaveBeenCalledWith(
      "researcher-1",
      "RESEARCH_EXPORT_CREATE",
      "export-1",
      { format: "csv" },
    )
  })

  it("writes no audit row when the OMOP gate refuses the request", async () => {
    await POST(exportRequest("omop-json"))

    expect(logAuditMock).not.toHaveBeenCalled()
  })

  it("records every download with the artifact checksum", async () => {
    openExportMock.mockResolvedValue({
      stream: null,
      contentType: "text/csv",
      contentLength: 12,
      filename: "cohort.csv",
      record: {
        format: "csv",
        rowCount: 42,
        checksum: "abc123",
        asOf: null,
        snapshotHash: null,
      },
    })

    const response = await DOWNLOAD(
      new Request("http://localhost/v1/research/exports/export-1/download"),
      { params: Promise.resolve({ id: "export-1" }) },
    )

    expect(response.status).toBe(200)
    expect(logAuditMock).toHaveBeenCalledWith(
      "researcher-1",
      "RESEARCH_EXPORT_DOWNLOAD",
      "export-1",
      { format: "csv", rowCount: 42, checksum: "abc123" },
    )
  })
})
