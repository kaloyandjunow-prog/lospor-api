import type { NextRequest } from "next/server"
import {
  GET as getClinicalRulesWorkbench,
  POST as postClinicalRulesWorkbench,
} from "../../clinical/rules/workbench/route"

// Temporary compatibility route for older v8 clients.
export async function GET(request: NextRequest) {
  return getClinicalRulesWorkbench(request)
}

export async function POST(request: NextRequest) {
  return postClinicalRulesWorkbench(request)
}

