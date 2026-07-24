import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@lospor/core"],
  serverExternalPackages: ["puppeteer-core", "@sparticuz/chromium"],
  poweredByHeader: false,
}

export default nextConfig
