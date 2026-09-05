import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Git/worktree fixtures exceed Vitest's five-second default on hosted Windows.
    // Runtime deadlines and cancellation assertions keep their explicit limits.
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary"],
      thresholds: {
        statements: 46.98,
        branches: 73.70,
        functions: 52,
        lines: 57.77,
      },
    },
  },
});
