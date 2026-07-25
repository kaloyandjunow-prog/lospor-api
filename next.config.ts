import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@lospor/core"],
  serverExternalPackages: ["puppeteer-core", "@sparticuz/chromium"],
  outputFileTracingIncludes: {
    "/v1/search/procedures": ["./src/data/pcs.json"],
    "/v1/search/drugs": ["./src/data/drugs.json"],
  },
  poweredByHeader: false,
}

export default nextConfig
