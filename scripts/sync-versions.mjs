/**
 * 跑版本同步命令行：把 src/collector/version-sync-cli.ts 打成单文件再执行。
 *
 * 为什么用 esbuild 而不是 tsx：仓库里已经有 esbuild（定时任务容器的打包脚本在用），
 * 不必再引一个运行时依赖。
 *
 * `packages: "external"` —— 依赖**不打包**，运行时从仓库的 node_modules 解析。
 * 这一步是必须的：把 `@prisma/client`（CJS）打进 ESM 产物里，它内部的
 * `__dirname` 会变成未定义（esbuild 不会给 ESM 产物补 `__dirname`）。
 * 产物落在仓库内的 `dist/`（已 gitignore），Node 才能按目录向上找到 node_modules。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(repoRoot, "dist");
mkdirSync(distDir, { recursive: true });
const outfile = path.join(distDir, "sync-versions.mjs");

await build({
  entryPoints: [path.join(repoRoot, "src", "collector", "version-sync-cli.ts")],
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
