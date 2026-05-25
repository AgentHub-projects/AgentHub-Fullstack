import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.spec.ts"],
    testTimeout: 15000,
    hookTimeout: 15000
  },
  resolve: {
    alias: {
      "@agenthub/shared": new URL("../shared/src/index.ts", import.meta.url).pathname
    }
  }
});
