import { describe, expect, it } from "vitest"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import document from "@/generated/openapi.json"

const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"]
const appRoot = resolve(process.cwd(), "src", "app", "v1")

function routeFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return routeFiles(path)
    return entry.name === "route.ts" ? [path] : []
  })
}

describe("OpenAPI route coverage", () => {
  it("documents every non-internal V1 operation", () => {
    for (const file of routeFiles(appRoot)) {
      const route = relative(appRoot, dirname(file)).replaceAll("\\", "/")
      const path = `/v1/${route}`.replace(/\[([^\]]+)\]/g, "{$1}")
      if (path.startsWith("/v1/internal/")) continue
      const source = readFileSync(file, "utf8")
      for (const method of methods) {
        if (!new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\b`).test(source)) {
          continue
        }
        const operation = document.paths[path as keyof typeof document.paths]
        expect(
          operation?.[method.toLowerCase() as keyof typeof operation],
          `${method} ${path} is missing`,
        ).toBeDefined()
      }
    }
  })
})
