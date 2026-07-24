import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const appRoot = join(root, "src", "app", "v1")
const output = join(root, "src", "generated", "openapi.json")
const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"]
const publicOperations = new Set([
  "GET /v1/capabilities",
  "GET /v1/institutions",
  "POST /v1/auth/check-pending",
  "POST /v1/auth/password-reset/confirm",
  "POST /v1/auth/password-reset/request",
  "POST /v1/auth/register",
  "POST /v1/auth/session",
  "POST /v1/auth/token",
  "POST /v1/auth/verify-email",
  "POST /v1/auth/verify-email/resend",
])

function routeFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return routeFiles(path)
    return entry.name === "route.ts" ? [path] : []
  })
}

function openApiPath(file) {
  const route = relative(appRoot, dirname(file)).replaceAll("\\", "/")
  return `/v1/${route}`
    .replace(/\[([^\]]+)\]/g, "{$1}")
    .replace(/\/$/, "")
}

const paths = {}
for (const file of routeFiles(appRoot).sort()) {
  const path = openApiPath(file)
  if (path.startsWith("/v1/internal/")) continue
  const source = readFileSync(file, "utf8")
  const tag = path.split("/")[2] ?? "service"
  const operations = {}
  for (const method of methods) {
    if (!new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\b`).test(source)) {
      continue
    }
    const operationId = `${method.toLowerCase()}_${path
      .replace(/^\/v1\//, "")
      .replace(/[{}]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "_")}`
    operations[method.toLowerCase()] = {
      operationId,
      tags: [tag],
      ...(publicOperations.has(`${method} ${path}`) ? { security: [] } : {}),
      ...(path.includes("{")
        ? {
            parameters: [...path.matchAll(/\{([^}]+)\}/g)].map(([, name]) => ({
              name,
              in: "path",
              required: true,
              schema: { type: "string" },
            })),
          }
        : {}),
      responses: {
        200: { description: "Successful response" },
        400: {
          description: "Invalid request",
          content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } },
        },
        401: {
          description: "Authentication required",
          content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } },
        },
        403: {
          description: "Insufficient access",
          content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } },
        },
        500: {
          description: "Server error",
          content: { "application/json": { schema: { $ref: "#/components/schemas/ApiError" } } },
        },
      },
    }
  }
  paths[path] = operations
}

const document = {
  openapi: "3.1.0",
  info: {
    title: "LOSPOR API",
    version: "7.0.0-dev.0",
    description:
      "First-party V1 contract for LOSPOR web, native mobile, and PWA clients.",
  },
  servers: [{ url: "http://localhost:3002" }],
  security: [{ bearerAuth: [] }, { cookieAuth: [] }],
  paths,
  components: {
    schemas: {
      ApiError: {
        type: "object",
        required: ["error"],
        properties: {
          error: { type: "string" },
          code: { type: "string" },
          requestId: { type: "string", format: "uuid" },
          details: {},
        },
      },
    },
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      cookieAuth: { type: "apiKey", in: "cookie", name: "lospor_session" },
    },
  },
}

writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`, "utf8")
