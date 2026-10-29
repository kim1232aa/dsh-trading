import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
    setupFiles: ["./test/vitest-setup-kline.ts"],
  },
});
