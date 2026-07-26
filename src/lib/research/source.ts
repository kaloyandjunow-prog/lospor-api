import type {
  ResearchBenchmarkRequest,
  ResearchBenchmarkResponse,
  ResearchComparisonRequest,
  ResearchComparisonResponse,
  ResearchMetadata,
  ResearchQueryRequest,
  ResearchQueryResponse,
  ResearchQualityResponse,
} from "@lospor/core/research"
import type { ResearchContext } from "./access"
import {
  benchmarkResearchCohort,
  compareResearchCohorts,
  researchMetadata,
  researchQuality,
  runResearchQuery,
} from "./service"

export interface ResearchDataSource {
  readonly kind: "LOSPOR" | "OMOP"
  metadata(context: ResearchContext): Promise<ResearchMetadata>
  query(request: ResearchQueryRequest, context: ResearchContext): Promise<ResearchQueryResponse>
  compare(request: ResearchComparisonRequest, context: ResearchContext): Promise<ResearchComparisonResponse>
  benchmark(request: ResearchBenchmarkRequest, context: ResearchContext): Promise<ResearchBenchmarkResponse>
  quality(context: ResearchContext): Promise<ResearchQualityResponse>
}

const losporSource: ResearchDataSource = {
  kind: "LOSPOR",
  metadata: researchMetadata,
  query: runResearchQuery,
  compare: compareResearchCohorts,
  benchmark: benchmarkResearchCohort,
  quality: researchQuality,
}

// The selector is intentionally centralized. A future central OMOP deployment
// can provide the same contract without changing route handlers or the browser.
export function researchDataSource(): ResearchDataSource {
  return losporSource
}
