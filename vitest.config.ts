import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts",
        "src/cli/**",
        // Requires a live Playwright browser; exercised manually, not in CI.
        "src/submission/browser.ts",
      ],
      thresholds: {
        statements: 80,
        lines: 80,
        functions: 80,
      },
    },
  },
});
