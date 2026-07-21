import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    globalSetup: ["tests/global-setup.ts"],
    include: ["src/**/tests/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
