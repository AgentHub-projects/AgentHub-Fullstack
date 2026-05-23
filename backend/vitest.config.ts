import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.spec.ts"]
  },
  resolve: {
    alias: {
      "@agenthub/shared": new URL("../shared/src/index.ts", import.meta.url).pathname
    }
  }
});
