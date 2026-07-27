import { NextResponse } from "next/server"
import type { ResearchDataAction, ResearchPermissionSet } from "@lospor/core/research"
import { getAuthUser } from "@/lib/mobile-auth"
import {
  researchContextForAction,
  resolveResearchContext,
  type ResearchContext,
} from "./access"

function actionForPermission(permission: keyof ResearchPermissionSet): ResearchDataAction {
  if (permission === "inspectCases") return "inspectCases"
  if (permission === "export") return "export"
  if (permission === "exportOmop") return "exportOmop"
  return "query"
}

export async function authorizeResearchRequest(
  request: Request,
  permission: keyof ResearchPermissionSet = "query",
): Promise<{ context: ResearchContext } | { response: NextResponse }> {
  const user = await getAuthUser(request)
  if (!user?.id) {
    return {
      response: NextResponse.json(
        { error: "Authentication required", code: "UNAUTHORIZED" },
        { status: 401 },
      ),
    }
  }
  const context = await resolveResearchContext(user)
  if (!context) {
    return {
      response: NextResponse.json(
        { error: "Research access has not been granted", code: "RESEARCH_ACCESS_REQUIRED" },
        { status: 403 },
      ),
    }
  }
  if (!context.permissions[permission]) {
    return {
      response: NextResponse.json(
        { error: "This research action is not permitted", code: "RESEARCH_PERMISSION_REQUIRED" },
        { status: 403 },
      ),
    }
  }
  return { context: researchContextForAction(context, actionForPermission(permission)) }
}

export function researchRouteError(error: unknown): NextResponse {
  if (error instanceof SyntaxError) {
    return NextResponse.json({ error: "Invalid JSON request", code: "INVALID_JSON" }, { status: 400 })
  }
  console.error("[research]", error)
  return NextResponse.json(
    { error: "Research request failed", code: "RESEARCH_REQUEST_FAILED" },
    { status: 500 },
  )
}
