/**
 * 跑「批量重跑中文简介」命令行：把 src/collector/summary-cli.ts 打成单文件再执行。
 *
 * 与 collect-batch.mjs 同理：`packages: "external"` —— 依赖不打包，
 * 运行时从仓库的 node_modules 解析（@prisma/client 是 CJS 包，
 * 打进 ESM 产物里它内部的 __dirname 会变成未定义）。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(repoRoot, "dist");
mkdirSync(distDir, { recursive: true });
const outfile = path.join(distDir, "regenerate-summaries.mjs");

await build({
  entryPoints: [path.join(repoRoot, "src", "collector", "summary-cli.ts")],
  outfile,
  bundle: true,
  packages: "external",
  platform: "node",
  target: "node22",
  format: "esm",
  logLevel: "warning",
});

const result = spawnSync(process.execPath, [outfile, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: repoRoot,
});

process.exit(result.status ?? 1);
