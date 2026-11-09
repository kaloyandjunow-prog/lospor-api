import type { NextConfig } from "next"
import { resolve } from "node:path"

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@lospor/core"],
  // Keep Turbopack anchored to the monorepo so the local Core package (used by
  // the serverless build) is resolved through its package exports.
  turbopack: { root: resolve(__dirname, "..") },
  serverExternalPackages: ["puppeteer-core", "@sparticuz/chromium"],
  outputFileTracingIncludes: {
    "/v1/search/procedures": ["./src/data/pcs.json", "./src/data/procedure-terms-bg.json"],
    "/v1/search/procedures/codes": ["./src/data/pcs.json", "./src/data/procedure-terms-bg.json"],
  },
  poweredByHeader: false,
}

export default nextConfig
