import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const srcDir = fileURLToPath(new URL("./src", import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.ts"],
    // 测试文件串行执行：每个测试前会清库，串行才能保证文件之间也互不干扰。
    fileParallelism: false,
    testTimeout: 30_000,
    // 建库 + 跑迁移比较慢，给 hook 留足时间。
    hookTimeout: 120_000,
  },
  resolve: {
    alias: {
      "@": srcDir,
    },
  },
});
