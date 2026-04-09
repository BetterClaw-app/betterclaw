import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/e2e/**/*.test.ts"],
    restoreMocks: true,
    unstubGlobals: true,
    testTimeout: 15_000,
  },
});
