/**
 * Seam 1 —— 采集边界（主 seam，票 #13）。
 *
 * MCP 官方 registry 是**权威来源**（免鉴权、字段最规整），这里用录制的 fixture
 * （真实响应体）驱动，**一个网络请求都不打**。
 *
 * 四类覆盖：
 *   1. 正常条目      —— servers-page-1.json（本地包 / 远程端点 / 密钥头 / URL 变量）
 *   2. 字段缺失      —— servers-missing-fields.json（packages / environmentVariables
 *                       / repository / runtimeArguments 整个不存在）
 *   3. 结构变更      —— servers-changed-shape.json（servers 不再是数组）
 *   4. 分页与去重    —— servers-page-1.json + servers-page-2.json
 *
 * ⚠️ 结构变更必须**显式抛错**（SourceStructureError），不能静默返回空条目 ——
 *    否则上游改版时采集器会安静地采到 0 条，看不出是「没数据」还是「解析炸了」。
 *
 * ⚠️ 采集请求**始终带 version=latest**，且入库前再校验 `isLatest === true`，
 *    所以列表里不会出现废弃版本（验收标准第 6 条）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SourceStructureError } from "@/collector/errors";
import { McpRegistryAdapter } from "@/collector/mcp-registry";
import type { HttpClient } from "@/collector/http";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp-registry");

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), "utf8");
}

/** 打桩的 HTTP 客户端：按 URL 路由到 fixture。记录调用过的 URL。 */
function createStubHttp(
  routes: { match: (url: string) => boolean; body: (url: string) => string }[],
): { http: HttpClient; calls: string[] } {
  const calls: string[] = [];

  const http: HttpClient = async (url) => {
    calls.push(url);
    const route = routes.find((candidate) => candidate.match(url));
    if (!route) {
      throw new Error(`fixture 未覆盖这个 URL：${url}`);
    }
    return new Response(route.body(url), { status: 200 });
  };

  return { http, calls };
}

const REGISTRY = "https://registry.modelcontextprotocol.io/v0/servers";

/** registry 列表路由：第一页 / 第二页（按 cursor 区分）。 */
function registryRoutes(overrides: { page1?: string; page2?: string } = {}) {
  return [
    {
      match: (url: string) => url.startsWith(REGISTRY) && !url.includes("cursor="),
      body: () => overrides.page1 ?? fixture("servers-page-1.json"),
    },
    {
      match: (url: string) => url.startsWith(REGISTRY) && url.includes("cursor="),
      body: () => overrides.page2 ?? fixture("servers-page-2.json"),
    },
  ];
}

/** 造一个适配器：HTTP 打桩，star 与工具发现都注入假实现。 */
function createAdapter(options: {
  routes: { match: (url: string) => boolean; body: (url: string) => string }[];
  stars?: Map<string, { stars: number; pushedAt: Date | null; updatedAt: Date | null }>;
  tools?: Map<string, { name: string; description: string | null; inputSchema: unknown }[] | null>;
}) {
  const { http, calls } = createStubHttp(options.routes);
  const adapter = new McpRegistryAdapter({
    http,
    fetchStars: async () => options.stars ?? new Map(),
    discoverTools: async (url) => options.tools?.get(url) ?? null,
  });
  return { adapter, calls };
}

describe("MCP registry 适配器 —— 正常条目", () => {
  it("解析出条目、丢弃废弃版本", async () => {
    const { adapter } = createAdapter({ routes: registryRoutes() });

    const result = await adapter.fetch({ type: "mcp-registry" });

    // fixture 第一页 9 条：8 条最新 + 1 条 isLatest=false（废弃版本）。
    const names = result.items.map((item) => item.metadata.mcp?.serverName);
    expect(names).toContain("ac.inference.sh/mcp");
    expect(names).toContain("com.pulsemcp/remote-filesystem");
    expect(names).toContain("ai.circulara/plugin");
    // 废弃版本（v1.0.0）不能进列表。
    const inference = result.items.filter(
      (item) => item.metadata.mcp?.serverName === "ac.inference.sh/mcp",
    );
    expect(inference).toHaveLength(1);
    expect(inference[0]?.metadata.mcp?.serverVersion).toBe("2.0.1");
  });

  it("请求始终带 version=latest", async () => {
    const { adapter, calls } = createAdapter({ routes: registryRoutes() });

    await adapter.fetch({ type: "mcp-registry" });

    const registryCalls = calls.filter((url) => url.startsWith(REGISTRY));
    expect(registryCalls.length).toBeGreaterThan(0);
    expect(registryCalls.every((url) => url.includes("version=latest"))).toBe(true);
  });

  it("翻页时把 nextCursor 原样回填", async () => {
    const { adapter, calls } = createAdapter({ routes: registryRoutes() });

    const result = await adapter.fetch({ type: "mcp-registry" });

    const withCursor = calls.filter((url) => url.includes("cursor="));
    expect(withCursor).toHaveLength(1);
    expect(withCursor[0]).toContain("cursor=ac.inference.sh%2Fmcp%3A2.0.1");
    // 第二页里那条最新版本也要采到。
    expect(result.items.map((item) => item.metadata.mcp?.serverName)).toContain(
      "io.github.acme/weather",
    );
  });

  it("传输方式 / 环境变量 / 端口 / 配置片段都落在结构化字段里", async () => {
    const { adapter } = createAdapter({ routes: registryRoutes() });

    const result = await adapter.fetch({ type: "mcp-registry" });

    const local = result.items.find(
      (item) => item.metadata.mcp?.serverName === "com.pulsemcp/remote-filesystem",
    );
    expect(local?.metadata.mcp?.transport).toBe("stdio");
    expect(local?.metadata.mcp?.envVars.map((variable) => variable.name)).toContain("GCS_BUCKET");
    expect(
      local?.metadata.mcp?.envVars.find((variable) => variable.name === "GCS_BUCKET")?.required,
    ).toBe(true);
    expect(local?.metadata.mcp?.config).toMatchObject({
      "com.pulsemcp/remote-filesystem": {
        command: "npx",
        args: ["-y", "remote-filesystem-mcp-server"],
      },
    });

    const remote = result.items.find(
      (item) => item.metadata.mcp?.serverName === "ac.inference.sh/mcp",
    );
    expect(remote?.metadata.mcp?.transport).toBe("http");
    expect(remote?.metadata.mcp?.config).toMatchObject({
      "ac.inference.sh/mcp": { type: "http", url: "https://api.inference.sh/mcp" },
    });

    const sse = result.items.find((item) => item.metadata.mcp?.serverName === "ai.biel/biel-ai");
    expect(sse?.metadata.mcp?.transport).toBe("sse");
  });

  it("工具定义来自在线探测，采不到时留 null（不编造）", async () => {
    const { adapter } = createAdapter({
      routes: registryRoutes(),
      tools: new Map([
        [
          "https://api.inference.sh/mcp",
          [{ name: "run", description: "跑一个推理", inputSchema: { type: "object" } }],
        ],
      ]),
    });

    const result = await adapter.fetch({ type: "mcp-registry" });

    const withTools = result.items.find(
      (item) => item.metadata.mcp?.serverName === "ac.inference.sh/mcp",
    );
    expect(withTools?.metadata.mcp?.tools).toEqual([
      { name: "run", description: "跑一个推理", inputSchema: { type: "object" } },
    ]);

    const withoutTools = result.items.find(
      (item) => item.metadata.mcp?.serverName === "ai.codenib/codenib",
    );
    // 没探测到就是 null，不是空数组 —— 「没取到」与「确实没有」要分得清。
    expect(withoutTools?.metadata.mcp?.tools).toBeNull();
  });

  it("slug 归一化后唯一，仓库信息落到 repoOwner / repoName", async () => {
    const { adapter } = createAdapter({ routes: registryRoutes() });

    const result = await adapter.fetch({ type: "mcp-registry" });

    const slugs = result.items.map((item) => item.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs).toContain("ac-inference-sh-mcp");

    const remote = result.items.find(
      (item) => item.metadata.mcp?.serverName === "ac.inference.sh/mcp",
    );
    expect(remote?.metadata.repoOwner).toBe("pulsemcp");
    expect(remote?.metadata.repoName).toBe("mcp-servers");
  });

  it("仓库 star 与仓库最近推送时间来自 GitHub 自算结果", async () => {
    const { adapter } = createAdapter({
      routes: registryRoutes(),
      stars: new Map([
        [
          "pulsemcp/mcp-servers",
          { stars: 81, pushedAt: new Date("2026-10-09T17:32:15Z"), updatedAt: null },
        ],
      ]),
    });

    const result = await adapter.fetch({ type: "mcp-registry" });

    const remote = result.items.find(
      (item) => item.metadata.mcp?.serverName === "ac.inference.sh/mcp",
    );
    expect(remote?.metadata.stars).toBe(81);
    expect(remote?.metadata.mcp?.repoPushedAt).toEqual(new Date("2026-10-09T17:32:15Z"));
    expect(remote?.metadata.heatScore).toBeGreaterThan(0);

    // 没有仓库的条目：star 是 0（不是 NaN），不报错、不阻塞。
    const noRepo = result.items.find(
      (item) => item.metadata.mcp?.serverName === "ai.codenib/codenib",
    );
    expect(noRepo?.metadata.stars).toBe(0);
  });
});

describe("MCP registry 适配器 —— 字段缺失", () => {
  it("packages / environmentVariables / repository 都没有的条目照常入库", async () => {
    const { adapter } = createAdapter({
      routes: [
        { match: (url) => url.startsWith(REGISTRY), body: () => fixture("servers-missing-fields.json") },
      ],
    });

    const result = await adapter.fetch({ type: "mcp-registry" });

    expect(result.items).toHaveLength(2);
    const bare = result.items.find((item) => item.metadata.mcp?.serverName === "io.github.bare/minimal");
    expect(bare?.metadata.mcp?.transport).toBe("unknown");
    expect(bare?.metadata.mcp?.envVars).toEqual([]);
    expect(bare?.metadata.mcp?.ports).toEqual([]);
    expect(bare?.metadata.mcp?.config).toEqual({});
    expect(bare?.metadata.mcp?.tools).toBeNull();
    expect(bare?.metadata.repoOwner).toBe("");

    const noEnv = result.items.find(
      (item) => item.metadata.mcp?.serverName === "io.github.bare/package-without-env",
    );
    // environmentVariables 整个不存在 → 清单是空的，但条目本身要能生成配置片段。
    expect(noEnv?.metadata.mcp?.envVars).toEqual([]);
    expect(noEnv?.metadata.mcp?.config).toMatchObject({
      "io.github.bare/package-without-env": { command: "npx", args: ["bare-mcp-server"] },
    });
  });
});

describe("MCP registry 适配器 —— 结构变更必须显式失败", () => {
  it("servers 不再是数组：抛 SourceStructureError，不返回空条目", async () => {
    const { adapter } = createAdapter({
      routes: [
        {
          match: (url) => url.startsWith(REGISTRY),
          body: () => fixture("servers-changed-shape.json"),
        },
      ],
    });

    await expect(adapter.fetch({ type: "mcp-registry" })).rejects.toBeInstanceOf(
      SourceStructureError,
    );
  });

  it("条目的 server.name 没了：抛 SourceStructureError", async () => {
    const { adapter } = createAdapter({
      routes: [
        {
          match: (url) => url.startsWith(REGISTRY),
          body: () =>
            JSON.stringify({
              servers: [{ server: { version: "1.0.0" } }],
              metadata: { count: 1 },
            }),
        },
      ],
    });

    await expect(adapter.fetch({ type: "mcp-registry" })).rejects.toBeInstanceOf(
      SourceStructureError,
    );
  });

  it("metadata 没了：抛 SourceStructureError", async () => {
    const { adapter } = createAdapter({
      routes: [
        {
          match: (url) => url.startsWith(REGISTRY),
          body: () =>
            JSON.stringify({
              servers: [
                {
                  server: { name: "a/b", version: "1.0.0" },
                  _meta: { "io.modelcontextprotocol.registry/official": { isLatest: true } },
                },
              ],
            }),
        },
      ],
    });

    await expect(adapter.fetch({ type: "mcp-registry" })).rejects.toBeInstanceOf(
      SourceStructureError,
    );
  });

  it("_meta 的形状变了（整页没有一条 isLatest=true）：抛 SourceStructureError", async () => {
    const { adapter } = createAdapter({
      routes: [
        {
          match: (url) => url.startsWith(REGISTRY),
          body: () =>
            JSON.stringify({
              servers: [
                {
                  server: { name: "a/b", version: "1.0.0" },
                  _meta: { "io.modelcontextprotocol.registry/publisher-provided": {} },
                },
              ],
              metadata: { count: 1 },
            }),
        },
      ],
    });

    await expect(adapter.fetch({ type: "mcp-registry" })).rejects.toBeInstanceOf(
      SourceStructureError,
    );
  });
});

describe("MCP registry 适配器 —— 配置与合规", () => {
  it("配置不合法时直接抛错，不发请求", async () => {
    const { adapter, calls } = createAdapter({ routes: registryRoutes() });

    await expect(
      adapter.fetch({ type: "mcp-registry", limit: 500 }),
    ).rejects.toThrow(/limit/i);
    expect(calls).toHaveLength(0);
  });

  it("只访问官方 registry 与 GitHub API，不碰任何 /api/ 路径", async () => {
    const { adapter, calls } = createAdapter({ routes: registryRoutes() });

    await adapter.fetch({ type: "mcp-registry" });

    expect(calls.every((url) => !url.includes("/api/"))).toBe(true);
    expect(
      calls.every(
        (url) =>
          url.startsWith("https://registry.modelcontextprotocol.io/") ||
          url.startsWith("https://api.github.com/"),
      ),
    ).toBe(true);
  });
});
