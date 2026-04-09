import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["test/e2e/**", "node_modules/**"],
    restoreMocks: true,
    unstubGlobals: true,
    testTimeout: 10_000,
  },
});
