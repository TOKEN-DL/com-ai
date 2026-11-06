#!/usr/bin/env node
/**
 * pnpm postinstall：生成 Prisma Client。
 *
 * Prisma 的 schema 里有 env("DATABASE_URL")，而 `prisma generate` 不需要真的连库，
 * 但仍要求这个变量存在。这里在缺失时补一个占位符，保证「刚 clone 下来直接
 * pnpm install」不会因为没有 .env 而失败。
 *
 * 真正的连接串一律在运行时由环境变量注入，绝不写进镜像或代码。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prismaCli = path.join(repoRoot, "node_modules", "prisma", "build", "index.js");

if (!existsSync(prismaCli)) {
  console.warn("[postinstall] 找不到 prisma CLI，跳过 prisma generate");
  process.exit(0);
}

process.env.DATABASE_URL ??= "postgresql://placeholder:placeholder@127.0.0.1:5432/placeholder";

execFileSync(process.execPath, [prismaCli, "generate"], {
  cwd: repoRoot,
  stdio: "inherit",
});
