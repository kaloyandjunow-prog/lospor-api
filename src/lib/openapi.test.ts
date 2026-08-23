import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import document from "@/generated/openapi.json"
import internalDocument from "@/generated/openapi-internal.json"
import { API_RELEASE_VERSION } from "@/lib/api-version"

const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"]
const appRoot = resolve(process.cwd(), "src", "app")

type ContractParameter = {
  name: string
  in: string
  required?: boolean
}

type ContractSchema = {
  $ref?: string
  oneOf?: ContractSchema[]
  allOf?: ContractSchema[]
  properties?: Record<string, ContractSchema>
  required?: string[]
  additionalProperties?: boolean
  minItems?: number
  maxItems?: number
}

type ContractResponse = {
  content?: Record<string, { schema?: ContractSchema }>
}

type ContractOperation = {
  operationId: string
  parameters?: ContractParameter[]
  responses: Record<string, ContractResponse>
  "x-lospor-explicit-contract"?: boolean
  "x-lospor-tombstone"?: boolean
}

type ContractPathItem = Partial<Record<Lowercase<(typeof methods)[number]>, ContractOperation>>
type ContractDocument = {
  info: { version: string }
  paths: Record<string, ContractPathItem>
  components: { schemas: Record<string, ContractSchema> }
}

const publicContract = document as unknown as ContractDocument
const internalContract = internalDocument as unknown as ContractDocument

function routeFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return routeFiles(path)
    return entry.name === "route.ts" ? [path] : []
  })
}

function operations() {
  return [join(appRoot, "v1"), join(appRoot, "health")].flatMap(directory =>
    routeFiles(directory).flatMap(file => {
      const route = relative(appRoot, dirname(file)).replaceAll("\\", "/")
      const path = `/${route}`.replace(/\[([^\]]+)\]/g, "{$1}")
      const source = readFileSync(file, "utf8")
      return methods
        .filter(method => new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\b`).test(source))
        .map(method => ({ method, path }))
    }))
}

describe("OpenAPI contract", () => {
  it("publishes the API package release version", () => {
    expect(publicContract.info.version).toBe(API_RELEASE_VERSION)
    expect(internalContract.info.version).toBe(API_RELEASE_VERSION)
  })

  it("has an explicit contract for every implemented HTTP operation", () => {
    for (const { method, path } of operations()) {
      const operation = internalContract.paths[path]
      const contract = operation?.[method.toLowerCase() as Lowercase<(typeof methods)[number]>]
      expect(contract, `${method} ${path} is missing`).toBeDefined()
      expect(contract?.["x-lospor-explicit-contract"], `${method} ${path} is inferred`).toBe(true)
    }
  })

  it("publishes every supported non-internal route and keeps secret jobs private", () => {
    expect(publicContract.paths["/v1/internal/option-library-snapshot"]).toBeUndefined()
    expect(publicContract.paths["/v1/internal/purge-deleted"]).toBeUndefined()
    expect(internalContract.paths["/v1/internal/option-library-snapshot"]).toBeDefined()
    expect(internalContract.paths["/v1/internal/purge-deleted"]).toBeDefined()
    expect(publicContract.paths["/health/live"]).toBeDefined()
    expect(publicContract.paths["/health/ready"]).toBeDefined()
  })

  it("declares every path placeholder as a required path parameter", () => {
    for (const [path, pathItem] of Object.entries(internalContract.paths)) {
      const placeholders = [...path.matchAll(/\{([^}]+)\}/g)].map(match => match[1])
      for (const operation of Object.values(pathItem).filter(
        (candidate): candidate is ContractOperation => Boolean(candidate),
      )) {
        for (const placeholder of placeholders) {
          expect(
            operation.parameters?.some(parameter =>
              parameter.name === placeholder && parameter.in === "path" && parameter.required),
            `${operation.operationId} does not declare {${placeholder}}`,
          ).toBe(true)
        }
      }
    }
  })

  it("defines content for every successful response", () => {
    for (const pathItem of Object.values(internalContract.paths)) {
      for (const operation of Object.values(pathItem).filter(
        (candidate): candidate is ContractOperation => Boolean(candidate),
      )) {
        if (operation["x-lospor-tombstone"]) {
          expect(operation.responses["410"]?.content).toBeDefined()
          continue
        }
        const success = Object.entries(operation.responses)
          .find(([status]) => Number(status) >= 200 && Number(status) < 300)?.[1]
        expect(success, `${operation.operationId} has no success response`).toBeDefined()
        expect(success?.content, `${operation.operationId} has an untyped success response`).toBeDefined()
      }
    }
  })

  it("documents the actual email-verification and pending-check verbs", () => {
    expect(publicContract.paths["/v1/auth/check-pending"].get).toBeDefined()
    expect(publicContract.paths["/v1/auth/check-pending"].post).toBeUndefined()
    expect(publicContract.paths["/v1/auth/verify-email"].get).toBeDefined()
    expect(publicContract.paths["/v1/auth/verify-email"].post).toBeUndefined()
  })

  it("documents the API-owned bilingual audit action catalog", () => {
    expect(publicContract.paths["/v1/admin/audit-logs"].get?.responses["200"]
      ?.content?.["application/json"]?.schema).toEqual({
      $ref: "#/components/schemas/AuditLogPage",
    })
    expect(publicContract.components.schemas.AuditLogPage.required).toContain("actions")
    expect(publicContract.components.schemas.AuditLogPage.properties?.actions).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/AuditActionDefinition" },
    })
    expect(publicContract.components.schemas.AuditActionDefinition.required).toEqual([
      "code",
      "category",
      "labels",
    ])
  })

  it("documents the administrator MFA branch on both password-login operations", () => {
    for (const path of ["/v1/auth/session", "/v1/auth/token"]) {
      const continuation = publicContract.paths[path].post?.responses["202"]
        ?.content?.["application/json"]?.schema
      expect(continuation, `${path} is missing its 202 continuation`).toEqual({
        $ref: "#/components/schemas/MfaChallengeResponse",
      })
      expect(publicContract.paths[path].post?.responses["503"], `${path} is missing its fail-closed key error`)
        .toBeDefined()
    }
  })

  it("keeps successful MFA response variants satisfiable as closed objects", () => {
    const continuation = publicContract.components.schemas.MfaLoginContinuationResponse
    expect(continuation.oneOf).toEqual([
      { $ref: "#/components/schemas/MfaWebLoginContinuationResponse" },
      { $ref: "#/components/schemas/MfaNativeLoginContinuationResponse" },
    ])
    expect(continuation.allOf).toBeUndefined()

    const web = publicContract.components.schemas.MfaWebLoginContinuationResponse
    expect(web.required).toEqual(["user"])
    expect(web.additionalProperties).toBe(false)
    expect(web.properties?.recoveryCodes).toMatchObject({ minItems: 10, maxItems: 10 })

    const native = publicContract.components.schemas.MfaNativeLoginContinuationResponse
    expect(native.required).toEqual(["access_token", "token_type", "expires_in", "preferredLocale"])
    expect(native.additionalProperties).toBe(false)
    expect(native.properties?.recoveryCodes).toMatchObject({ minItems: 10, maxItems: 10 })
  })
})
