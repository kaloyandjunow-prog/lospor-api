import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import document from "@/generated/openapi.json"
import internalDocument from "@/generated/openapi-internal.json"

const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"]
const appRoot = resolve(process.cwd(), "src", "app")

type ContractParameter = {
  name: string
  in: string
  required?: boolean
}

type ContractResponse = {
  content?: unknown
}

type ContractOperation = {
  operationId: string
  parameters?: ContractParameter[]
  responses: Record<string, ContractResponse>
  "x-lospor-explicit-contract"?: boolean
}

type ContractPathItem = Partial<Record<Lowercase<(typeof methods)[number]>, ContractOperation>>
type ContractDocument = { paths: Record<string, ContractPathItem> }

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
})
