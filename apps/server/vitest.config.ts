import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@trema/connectors": fileURLToPath(
        new URL("../../packages/connectors/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    fileParallelism: false,
    globalSetup: ["tests/global-setup.ts"],
    include: ["src/**/tests/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
