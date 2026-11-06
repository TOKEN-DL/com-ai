/**
 * 架构护栏：**采集 cron 只有一个归属 —— 定时任务容器**。
 *
 * 之前采集跑在应用容器里（`src/instrumentation.ts`），有两个问题：
 *   1. 应用容器一多，**每个副本都会各自触发一次采集** —— 重复采集是正确性 bug；
 *   2. 采集负载（回源 GitHub / skills.sh）与请求服务在同一个容器里抢资源。
 *
 * 这条约束靠**架构**保证，不靠自觉：护栏直接扫源码里的 import / 调用，
 * 谁把采集 cron 挪回应用容器，测试立刻红。
 *
 * 走 TypeScript 的 AST 而不是正则：正则分不清「注释里提到」和「真的 import 了」。
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_ENTRY = path.join(REPO_ROOT, "src", "instrumentation.ts");
const APP_DIR = path.join(REPO_ROOT, "src", "app");
const WORKER_ENTRY = path.join(REPO_ROOT, "src", "worker", "index.ts");

/** 采集 cron 模块的导入路径（别名形式）。 */
const COLLECTION_CRON_MODULE = "@/collector/collection-cron";
/** 启动采集 cron 的函数名。 */
const COLLECTION_CRON_START = "startCollectionCron";

type ScanResult = {
  /// 引用到的模块说明符（静态 import + 动态 import()）。
  moduleSpecifiers: string[];
  /// 被调用的函数名（标识符调用 + 方法调用 `x.foo()`）。
  calledFunctions: string[];
};

/** 扫一个 TS 文件：抽出模块说明符与被调用的函数名。 */
function scanSource(source: string): ScanResult {
  const file = ts.createSourceFile(
    "scan.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const moduleSpecifiers: string[] = [];
  const calledFunctions: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      moduleSpecifiers.push(node.moduleSpecifier.text);
    }

    if (ts.isCallExpression(node)) {
      // 动态 import("...")
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        moduleSpecifiers.push(node.arguments[0].text);
      }
      if (ts.isIdentifier(node.expression)) {
        calledFunctions.push(node.expression.text);
      }
      // 方法调用：module.startCollectionCron() —— 方法名也要算。
      if (ts.isPropertyAccessExpression(node.expression)) {
        calledFunctions.push(node.expression.name.text);
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(file);

  return { moduleSpecifiers, calledFunctions };
}

/** 目录下的所有 .ts 文件。 */
function collectTypeScriptFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("采集 cron 的归属 —— 架构护栏", () => {
  it("扫描器本身认得出采集 cron（否则后面的否定断言就是恒真的）", () => {
    const worker = scanSource(readFileSync(WORKER_ENTRY, "utf8"));

    // 定时任务容器必须真的 import 并调用它。
    expect(worker.moduleSpecifiers).toContain(COLLECTION_CRON_MODULE);
    expect(worker.calledFunctions).toContain(COLLECTION_CRON_START);
  });

  it("应用容器不再引用采集 cron", () => {
    const app = scanSource(readFileSync(APP_ENTRY, "utf8"));

    expect(app.moduleSpecifiers).not.toContain(COLLECTION_CRON_MODULE);
    expect(app.calledFunctions).not.toContain(COLLECTION_CRON_START);
  });

  it("应用代码目录（src/app）里也没有采集 cron", () => {
    const files = collectTypeScriptFiles(APP_DIR);
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      const scan = scanSource(readFileSync(file, "utf8"));
      if (scan.moduleSpecifiers.includes(COLLECTION_CRON_MODULE)) {
        violations.push(path.relative(REPO_ROOT, file));
      }
    }

    expect(violations).toEqual([]);
  });

  it("定时任务容器会注册采集 cron", () => {
    const worker = scanSource(readFileSync(WORKER_ENTRY, "utf8"));

    expect(worker.moduleSpecifiers).toContain(COLLECTION_CRON_MODULE);
    expect(worker.calledFunctions).toContain(COLLECTION_CRON_START);
  });

  it("应用容器的 register() 不会启动采集 cron（行为级）", async () => {
    // 整体换掉 process.env：NODE_ENV 在类型上是只读的（Next.js 扩展了 ProcessEnv）。
    const originalEnv = { ...process.env };

    try {
      // 摆成生产环境：register() 在开发 / 测试环境本来就直接返回，
      // 那样这条断言就是恒真的。
      process.env = {
        ...originalEnv,
        NODE_ENV: "production",
        NEXT_RUNTIME: "nodejs",
      };
      delete process.env.COLLECTOR_CRON_ENABLED;

      const { register } = await import("@/instrumentation");
      await register();

      // 采集 cron 一条都没注册 ⇒ 应用容器确实不碰采集。
      const { collectionCronStatus } = await import("@/collector/collection-cron");
      expect(collectionCronStatus()).toEqual([]);
    } finally {
      process.env = { ...originalEnv };
    }
  });
});
