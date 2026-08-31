import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary"],
      thresholds: {
        statements: 46,
        branches: 53,
        functions: 52,
        lines: 46,
      },
    },
  },
});
