/**
 * 打包定时任务容器用的单文件产物：dist/worker.mjs
 *
 * 为什么用脚本而不是命令行参数：banner 里那段 JS 带引号，
 * 在 cmd / sh 里传参的转义各不相同，写在脚本里最稳。
 *
 * 三个关键点：
 *   1. 输出必须是 **ESM**：node-cron v4 是 ESM 包，内部用 import.meta.url
 *      定位自己的 daemon.js；打成 CJS 会让 import.meta.url 变成 undefined。
 *   2. 必须挂 createRequire 的 banner：pg 是 CJS 包，ESM 产物里 require()
 *      Node 内置模块（events 等）会直接抛 "Dynamic require of ... is not supported"。
 *   3. **`@prisma/client` 必须留在包外**（external）：Prisma 客户端不是普通
 *      库，它带着平台对应的**查询引擎二进制**（query_engine-*.so），引擎路径
 *      是按「客户端包在磁盘上的位置」算出来的。把它打进 bundle，引擎路径就
 *      算错了，运行时直接报 "Query engine library for schema ... was not found"。
 *      所以运行时从镜像里的 node_modules 解析（Dockerfile 的 worker 阶段
 *      已经把**已生成**的 Prisma 客户端带进去了）。
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
  // @prisma/client 见上面的说明 3：不能被 bundle。
  external: ["pg-native", "@prisma/client"],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: "info",
});
