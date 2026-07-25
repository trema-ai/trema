import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@trema/connectors": fileURLToPath(
        new URL("../../packages/connectors/src/index.ts", import.meta.url),
      ),
      "@trema/harness/testing": fileURLToPath(
        new URL("../../packages/harness/src/testing/index.ts", import.meta.url),
      ),
      "@trema/harness": fileURLToPath(
        new URL("../../packages/harness/src/index.ts", import.meta.url),
      ),
      "@trema/models": fileURLToPath(
        new URL("../../packages/models/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    fileParallelism: false,
    globalSetup: ["tests/global-setup.ts"],
    setupFiles: ["tests/setup.ts"],
    include: ["src/**/tests/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
