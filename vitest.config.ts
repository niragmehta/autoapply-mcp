import { defineConfig } from "vitest/config";

// Windows runners are slow at file-heavy tests (SQLite files, temp folders
// scanned on every write), so the default limits there read slowness as failure.
const slowFileSystem = process.platform === "win32";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    testTimeout: slowFileSystem ? 30_000 : 5_000,
    hookTimeout: slowFileSystem ? 60_000 : 10_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts",
        "src/cli/**",
        // Requires a live Playwright browser; exercised manually, not in CI.
        "src/submission/browser.ts",
        "src/submission/browser/**",
      ],
      thresholds: {
        statements: 80,
        lines: 80,
        functions: 80,
      },
    },
  },
});
