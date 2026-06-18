import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/__tests__/**/*.test.ts", "src/__tests__/**/*.test.tsx"],
    testTimeout: 10_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**", "dist/**"],
      thresholds: {
        lines: 81,
        functions: 83,
        branches: 77,
        statements: 80,
      },
    },
  },
});
