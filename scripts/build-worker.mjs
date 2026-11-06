/**
 * 打包定时任务容器用的单文件产物：dist/worker.mjs
 *
 * 为什么用脚本而不是命令行参数：banner 里那段 JS 带引号，
 * 在 cmd / sh 里传参的转义各不相同，写在脚本里最稳。
 *
 * 两个关键点：
 *   1. 输出必须是 **ESM**：node-cron v4 是 ESM 包，内部用 import.meta.url
 *      定位自己的 daemon.js；打成 CJS 会让 import.meta.url 变成 undefined。
 *   2. 必须挂 createRequire 的 banner：pg 是 CJS 包，ESM 产物里 require()
 *      Node 内置模块（events 等）会直接抛 "Dynamic require of ... is not supported"。
 */
import { build } from "esbuild";

await build({
  entryPoints: ["src/worker/index.ts"],
  outfile: "dist/worker.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  // pg-native 是可选的原生加速模块，装不上也不影响。
  external: ["pg-native"],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: "info",
});
