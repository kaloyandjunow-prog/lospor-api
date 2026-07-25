import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { buildDocument, contractKeys } from "./openapi-contract.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const appRoot = join(root, "src", "app")
const output = join(root, "src", "generated", "openapi.json")
const internalOutput = join(root, "src", "generated", "openapi-internal.json")
const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"]

function routeFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return routeFiles(path)
    return entry.name === "route.ts" ? [path] : []
  })
}

function routePath(file) {
  const route = relative(appRoot, dirname(file)).replaceAll("\\", "/")
  return `/${route}`.replace(/\[([^\]]+)\]/g, "{$1}").replace(/\/$/, "")
}

const implemented = new Set()
for (const directory of [join(appRoot, "v1"), join(appRoot, "health")]) {
  for (const file of routeFiles(directory)) {
    const path = routePath(file)
    const source = readFileSync(file, "utf8")
    for (const method of methods) {
      if (new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\b`).test(source)) {
        implemented.add(`${method} ${path}`)
      }
    }
  }
}

const missing = [...implemented].filter(key => !contractKeys.has(key))
const stale = [...contractKeys].filter(key => !implemented.has(key))
if (missing.length || stale.length) {
  throw new Error([
    missing.length ? `Missing explicit contracts:\n${missing.join("\n")}` : "",
    stale.length ? `Contracts without routes:\n${stale.join("\n")}` : "",
  ].filter(Boolean).join("\n\n"))
}

writeFileSync(output, `${JSON.stringify(buildDocument(), null, 2)}\n`, "utf8")
writeFileSync(
  internalOutput,
  `${JSON.stringify(buildDocument({ includeInternal: true }), null, 2)}\n`,
  "utf8",
)
