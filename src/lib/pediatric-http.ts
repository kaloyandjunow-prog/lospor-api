import { NextRequest, NextResponse } from "next/server"
import type { ClinicalMode } from "@lospor/core/pediatric"
import { decidePediatricCaseMutation } from "./pediatric-mode"

export function pediatricMutationResponse(
  request: NextRequest,
  clinicalMode: ClinicalMode,
): NextResponse | null {
  const decision = decidePediatricCaseMutation({
    clinicalMode,
    clientVersion: request.headers.get("x-lospor-client-version"),
  })
  if (decision.allowed) return null
  return NextResponse.json(
    {
      error: decision.code,
      ...decision,
    },
    { status: decision.status },
  )
}
