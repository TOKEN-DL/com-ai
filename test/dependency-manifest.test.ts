/**
 * 依赖清单解析（票 #17）—— 纯函数单元测试。
 *
 * 这里只验「格式对不对、错在哪」，不碰数据库：
 * 清单格式是平台与发布者之间的约定，解析规则必须能被单独盯住。
 *
 * 验收标准里有一条硬的：**声明格式非法时给出明确错误提示，而不是静默忽略**。
 * 所以每个非法用例都断言：错误消息里能看出**哪个字段**、**期望什么**，
 * 语法错误还要能看出**第几行第几列**。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_MANIFEST_FILENAME,
  DependencyManifestError,
  parseDependencyManifest,
  toManifestSnapshot,
} from "@/lib/dependency-manifest";

/** 断言抛出的确实是清单错误，并把消息取出来。 */
function expectManifestError(run: () => unknown): DependencyManifestError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DependencyManifestError);
    return error as DependencyManifestError;
  }
  throw new Error("期望抛出 DependencyManifestError，但没有抛。");
}

describe("依赖清单 —— 合法清单", () => {
  it("解析 YAML 清单：slug / kind / version 都读得出来", () => {
    const manifest = parseDependencyManifest(`
version: 1
dependencies:
  - slug: pdf-batch-processor
    kind: SKILL
    version: ">=1.2.0"
  - slug: pdf-mcp-server
`);

    expect(manifest.version).toBe(1);
    expect(manifest.dependencies).toEqual([
      { slug: "pdf-batch-processor", kind: "SKILL", version: ">=1.2.0" },
      { slug: "pdf-mcp-server" },
    ]);
  });

  it("JSON 清单也能解析（JSON 是 YAML 的子集）", () => {
    const manifest = parseDependencyManifest(
      JSON.stringify({
        version: 1,
        dependencies: [{ slug: "pdf-batch-processor", kind: "MCP" }],
      }),
    );

    expect(manifest.dependencies).toEqual([
      { slug: "pdf-batch-processor", kind: "MCP" },
    ]);
  });

  it("没写 dependencies = 没有依赖（合法，不是错误）", () => {
    const manifest = parseDependencyManifest("version: 1\n");

    expect(manifest.dependencies).toEqual([]);
  });

  it("空列表也是合法的「没有依赖」", () => {
    const manifest = parseDependencyManifest("dependencies: []\n");

    expect(manifest.dependencies).toEqual([]);
  });

  it("slug 的大小写与空格被归一化（站内 slug 全小写）", () => {
    const manifest = parseDependencyManifest(
      "dependencies:\n  - slug: '  PDF-Batch-Processor  '\n",
    );

    expect(manifest.dependencies[0]?.slug).toBe("pdf-batch-processor");
  });

  it("kind 大小写不敏感", () => {
    const manifest = parseDependencyManifest(
      "dependencies:\n  - slug: pdf-mcp-server\n    kind: mcp\n",
    );

    expect(manifest.dependencies[0]?.kind).toBe("MCP");
  });

  it("版本约束原样保留（只展示，不求解）", () => {
    const manifest = parseDependencyManifest(
      'dependencies:\n  - slug: pdf-batch-processor\n    version: ">=1.2.0"\n',
    );

    expect(manifest.dependencies[0]?.version).toBe(">=1.2.0");
  });

  it("清单文件名有平台约定的默认值", () => {
    expect(DEFAULT_MANIFEST_FILENAME).toBe("com-ai.manifest.yaml");
  });
});

describe("依赖清单 —— 格式非法必须报错（不能静默忽略）", () => {
  it("缺 slug：报出字段路径与期望值", () => {
    const error = expectManifestError(() =>
      parseDependencyManifest("dependencies:\n  - kind: SKILL\n"),
    );

    expect(error.message).toContain("dependencies[0].slug");
    expect(error.message).toContain("缺少 slug");
  });

  it("slug 不是字符串：报出实际类型", () => {
    const error = expectManifestError(() =>
      parseDependencyManifest("dependencies:\n  - slug: 42\n"),
    );

    expect(error.message).toContain("dependencies[0].slug");
    expect(error.message).toContain("必须是字符串");
    expect(error.message).toContain("数字");
  });

  it("slug 的形状不对：报出期望格式", () => {
    const error = expectManifestError(() =>
      parseDependencyManifest("dependencies:\n  - slug: 'PDF 处理器'\n"),
    );

    expect(error.message).toContain("dependencies[0].slug");
    expect(error.message).toContain("小写字母、数字与连字符");
  });

  it("kind 不是平台资产类型：报出可选值", () => {
    const error = expectManifestError(() =>
      parseDependencyManifest("dependencies:\n  - slug: pdf-mcp-server\n    kind: PACKAGE\n"),
    );

    expect(error.message).toContain("dependencies[0].kind");
    expect(error.message).toContain("SKILL / MCP / PROMPT");
  });

  it("顶层出现未知键：报出允许的键", () => {
    const error = expectManifestError(() =>
      parseDependencyManifest("version: 1\ndependencys: []\n"),
    );

    expect(error.message).toContain("顶层不允许这个键");
    expect(error.message).toContain("version / dependencies");
  });

  it("依赖声明里出现未知键：报出字段路径", () => {
    const error = expectManifestError(() =>
      parseDependencyManifest("dependencies:\n  - slug: pdf-mcp-server\n    url: https://x.test\n"),
    );

    expect(error.message).toContain("dependencies[0].url");
    expect(error.message).toContain("不允许这个键");
  });

  it("dependencies 不是列表：报出实际类型", () => {
    const error = expectManifestError(() =>
      parseDependencyManifest("dependencies: pdf-mcp-server\n"),
    );

    expect(error.message).toContain("dependencies");
    expect(error.message).toContain("必须是一个列表");
  });

  it("重复声明同一个依赖目标：报错而不是默默留一条", () => {
    const error = expectManifestError(() =>
      parseDependencyManifest(
        "dependencies:\n  - slug: pdf-mcp-server\n  - slug: pdf-mcp-server\n",
      ),
    );

    expect(error.message).toContain("重复声明");
    expect(error.message).toContain("dependencies[1]");
  });

  it("version 不是字符串：报错（版本约束只展示，但也要是字符串）", () => {
    const error = expectManifestError(() =>
      parseDependencyManifest("dependencies:\n  - slug: pdf-mcp-server\n    version: 1.2\n"),
    );

    expect(error.message).toContain("dependencies[0].version");
    expect(error.message).toContain("必须是字符串");
  });

  it("清单格式版本不认识：报错并说清支持哪个版本", () => {
    const error = expectManifestError(() => parseDependencyManifest("version: 2\n"));

    expect(error.message).toContain("version");
    expect(error.message).toContain("只支持 version 1");
  });

  it("YAML 语法错：报出第几行第几列", () => {
    const error = expectManifestError(() =>
      parseDependencyManifest("dependencies:\n  - slug: pdf-mcp-server\n   kind: SKILL\n"),
    );

    expect(error.message).toContain("不是合法的 YAML");
    // 语法错误的位置要能落到行列上（不是只说「解析失败」）。
    expect(error.issues.length).toBeGreaterThan(0);
    expect(error.issues[0]?.line).toBeGreaterThan(0);
  });

  it("多条问题一次报全（发布者不用来回试）", () => {
    const error = expectManifestError(() =>
      parseDependencyManifest("dependencies:\n  - kind: SKILL\n  - slug: 42\n"),
    );

    expect(error.issues.length).toBeGreaterThanOrEqual(2);
    expect(error.message).toContain("dependencies[0].slug");
    expect(error.message).toContain("dependencies[1].slug");
  });
});

describe("依赖清单 —— 快照", () => {
  it("快照是解析后的结构（可直接落 JSON 列）", () => {
    const manifest = parseDependencyManifest(
      "dependencies:\n  - slug: pdf-mcp-server\n    kind: MCP\n    version: latest\n",
    );

    expect(toManifestSnapshot(manifest)).toEqual([
      { slug: "pdf-mcp-server", kind: "MCP", version: "latest" },
    ]);
    expect(() => JSON.stringify(toManifestSnapshot(manifest))).not.toThrow();
  });
});
