import { NextResponse } from "next/server"
import { CLINICAL_CATALOG_VERSION } from "@lospor/core/catalog"
import { API_RELEASE_VERSION } from "@/lib/api-version"
import { pediatricCapabilities } from "@/lib/pediatric-mode"
import {
  accountAdministrationCapability,
  authenticationCapabilities,
  clinicalAiCapabilities,
  deploymentSupport,
} from "@/lib/deployment-capabilities"

export function GET() {
  return NextResponse.json({
    apiVersion: "1",
    serviceVersion: API_RELEASE_VERSION,
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
    support: deploymentSupport(),
    authentication: authenticationCapabilities(),
    features: {
      caseRevisions: true,
      idempotentEvents: true,
      offlineReplay: true,
      omopExport: true,
      externalClientCredentials: false,
      accountAdministration: accountAdministrationCapability(),
      clinicalAi: clinicalAiCapabilities(),
      pediatricMode: pediatricCapabilities(),
    },
  })
}
