/**
 * 合规护栏（票 #4 验收标准第 6 条）：
 * **采集器代码中不出现任何被目标站点 robots.txt 标记为 Disallow 的 `/api/` 路径。**
 *
 * 这条约束用**架构**保证，不靠自觉：护栏直接扫采集器源码里的字符串字面量，
 * 一旦有人往里写 `https://skills.sh/api/...` 这类路径，测试立刻红。
 *
 * 扫描范围只覆盖**字符串字面量**，不覆盖注释 —— 注释里可以讨论「为什么不能用 /api/」。
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COLLECTOR_DIR = path.join(REPO_ROOT, "src", "collector");

/**
 * 这些站点的 robots.txt 明确 `Disallow: /api/`（见 .com-ai-context/external-data-sources.md）。
 * 护栏不依赖这份清单也能工作（凡是 `/api/` 开头的路径都拦），这里是文档化的原因。
 */
const ROBOTS_DISALLOW_API_HOSTS = [
  "skills.sh",
  "api.smithery.ai",
  "smithery.ai",
  "mcp.so",
  "glama.ai",
] as const;

function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

/**
 * 抽出源码里的字符串字面量。
 *
 * 走 TypeScript 的 AST 而不是正则：正则分不清「注释里的反引号」和「模板字符串」，
 * 会把注释里讨论 `/api/` 的说明也当成字面量。AST 只认真正的字符串节点。
 */
function extractStringLiterals(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    "collector.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const literals: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      literals.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return literals;
}

/** 取 URL 的路径部分（去掉 scheme + host）；不是绝对 URL 就返回 null。 */
function urlPath(url: string): string | null {
  const parsed = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+([^?#]*)/i.exec(url);
  return parsed ? parsed[1] || "/" : null;
}

describe("采集器合规护栏", () => {
  const files = collectSourceFiles(COLLECTOR_DIR);

  it("采集器目录非空（护栏本身要真的在扫东西）", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("采集器源码里没有任何以 /api/ 开头的路径", () => {
    const violations: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const literal of extractStringLiterals(source)) {
        // 绝对 URL：看它的路径部分。
        for (const url of literal.match(/[a-z][a-z0-9+.-]*:\/\/[^\s"'`]+/gi) ?? []) {
          const pathname = urlPath(url);
          if (pathname && pathname.startsWith("/api/")) {
            violations.push(`${path.relative(REPO_ROOT, file)}：${url}`);
          }
        }
        // 相对路径字面量：直接以 /api/ 开头。
        if (literal.trim().startsWith("/api/")) {
          violations.push(`${path.relative(REPO_ROOT, file)}：${literal.trim()}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("采集器源码里没有出现被 robots.txt 禁止的站点 API 路径", () => {
    const violations: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const literal of extractStringLiterals(source)) {
        for (const host of ROBOTS_DISALLOW_API_HOSTS) {
          if (literal.includes(`${host}/api/`)) {
            violations.push(`${path.relative(REPO_ROOT, file)}：${literal}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("采集器源码里出现的网络主机只有 GitHub 官方 API、raw 域与仓库页", () => {
    const allowedHosts = new Set([
      "api.github.com",
      "raw.githubusercontent.com",
      // 只作为「来源仓库链接」存进数据库，不发起请求。
      "github.com",
    ]);
    const hosts = new Set<string>();

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const literal of extractStringLiterals(source)) {
        for (const url of literal.match(/https?:\/\/[^/\s"'`]+/gi) ?? []) {
          hosts.add(url.replace(/^https?:\/\//i, "").toLowerCase());
        }
      }
    }

    const unexpected = [...hosts].filter((host) => !allowedHosts.has(host));
    expect(unexpected).toEqual([]);
  });
});
