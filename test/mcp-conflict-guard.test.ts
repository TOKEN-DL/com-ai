/**
 * 冲突检测的「刻意不做」静态护栏（票 #14）。
 *
 * 验收标准里有一条：「未使用任何依赖求解或版本解析逻辑」。
 * 这条不能只靠人肉 review 保证 —— 用静态检查钉死（与
 * test/search-route.test.ts 里「检索不直查库」那条护栏同一个思路）：
 *
 *   1. 冲突检测模块**不 import 任何东西** —— 纯函数：不查库、不读配置，
 *      更不可能去遍历依赖图或解析版本约束；
 *   2. 实现代码里不出现版本 / 依赖 / 约束相关的字样
 *      （注释里写「不做依赖求解」是允许的，所以先剥掉注释）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 去掉注释，只留代码。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("冲突检测不使用依赖求解 / 版本解析", () => {
  const source = readFileSync(path.join(REPO_ROOT, "src/lib/mcp-conflict.ts"), "utf8");

  it("冲突检测模块不 import 任何东西（纯函数：不查库、不引版本库）", () => {
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toContain("semver");
    expect(source).not.toContain("@/lib/version-format");
    expect(source).not.toContain("@prisma/client");
  });

  it("实现里没有版本比较、依赖声明或约束求解", () => {
    const code = stripComments(source);

    expect(code).not.toMatch(/depend/i);
    expect(code).not.toMatch(/version/i);
    expect(code).not.toMatch(/constraint/i);
    expect(code).not.toMatch(/prisma/i);
  });
});
