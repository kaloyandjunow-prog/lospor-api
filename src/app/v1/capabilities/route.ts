import { NextResponse } from "next/server"
import { CLINICAL_CATALOG_VERSION } from "@lospor/core/catalog"

export function GET() {
  return NextResponse.json({
    apiVersion: "1",
    serviceVersion: process.env.npm_package_version ?? "7.2.0",
    catalogVersion: CLINICAL_CATALOG_VERSION,
    minimumSupportedClients: {
      web: "6.0.0",
      mobile: "6.0.0",
      pwa: "6.0.0",
    },
    compatibilityPaths: {
      canonical: "/v1",
      legacyWebProxy: "/api",
    },
    features: {
      caseRevisions: true,
      idempotentEvents: true,
      offlineReplay: true,
      omopExport: true,
      externalClientCredentials: false,
    },
  })
}
