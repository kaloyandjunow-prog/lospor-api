import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    // Unit/integration tests live under src/ and are named *.test.*.
    // Playwright e2e specs (e2e/*.spec.ts) must NOT be picked up by Vitest.
    include: ["src/**/*.test.{ts,tsx}"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
})
