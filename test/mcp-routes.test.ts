/**
 * Seam 2 —— HTTP 边界（票 #13）。
 *
 * 路由处理器对着**真实测试 Postgres** 跑（不用内存替身）。
 *
 * 覆盖票里的六条验收标准里能在这里验的四条：
 *   1. 详情页展示的工具定义包含名称、描述与参数结构；
 *   2. 详情页展示环境变量清单并标注哪些必填；
 *   3. 一键复制出的配置片段能直接粘进客户端使用；
 *   4. MCP 条目能被统一搜索命中。
 *
 * 数据通过 #3 的写入路径（writeAsset）落库 —— 与生产链路一致。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GET as getMcp } from "@/app/api/mcp/[slug]/route";
import McpDetailPage from "@/app/mcp/[slug]/page";
import McpListPage from "@/app/mcp/page";
import { GET as searchApi } from "@/app/api/search/route";
import SearchPage from "@/app/search/page";
import { writeAsset } from "@/lib/asset-writer";

/** 一个本地包（stdio）+ 环境变量 + 工具定义的条目。 */
async function seedLocalMcpServer(): Promise<void> {
  await writeAsset({
    kind: "MCP",
    slug: "com-pulsemcp-remote-filesystem",
    displayName: "Remote Filesystem MCP",
    license: null,
    summaryZh: "来自 pulsemcp/mcp-servers 的 MCP server「com.pulsemcp/remote-filesystem」。",
    summarySource: "TEMPLATE",
    repoOwner: "pulsemcp",
    repoName: "mcp-servers",
    repoUrl: "https://github.com/pulsemcp/mcp-servers",
    sourceId: "mcp-registry",
    stars: 81,
    publishedAt: new Date("2026-06-26T14:07:53.723164Z"),
    detail: {
      mcp: {
        transport: "stdio",
        serverName: "com.pulsemcp/remote-filesystem",
        serverDescription: "MCP server for remote filesystem operations on cloud storage.",
        repoPushedAt: new Date("2026-10-09T17:32:15.000Z"),
        packages: [
          {
            registryType: "npm",
            identifier: "remote-filesystem-mcp-server",
            version: "0.1.5",
            runtimeHint: "npx",
            transport: { type: "stdio" },
            runtimeArguments: [{ type: "positional", value: "-y" }],
            environmentVariables: [
              { name: "GCS_BUCKET", isRequired: true, description: "Google Cloud Storage bucket name." },
              { name: "GCS_PRIVATE_KEY", isSecret: true, description: "Service account private key." },
              { name: "GCS_MAKE_PUBLIC", default: "false" },
            ],
          },
        ],
        remotes: [],
        tools: [
          {
            name: "read_file",
            description: "读一个文件的内容。",
            inputSchema: {
              type: "object",
              properties: {
                path: { type: "string", description: "文件路径" },
                encoding: { type: "string", enum: ["utf-8", "base64"], default: "utf-8" },
              },
              required: ["path"],
            },
          },
        ],
        envVars: ["GCS_BUCKET", "GCS_PRIVATE_KEY", "GCS_MAKE_PUBLIC"],
        ports: [3000],
        configJson: {
          "com.pulsemcp/remote-filesystem": {
            command: "npx",
            args: ["-y", "remote-filesystem-mcp-server"],
            env: {
              GCS_BUCKET: "<GCS_BUCKET>",
              GCS_PRIVATE_KEY: "<GCS_PRIVATE_KEY_在这里填你的值>",
              GCS_MAKE_PUBLIC: "false",
            },
          },
        },
      },
    },
  });
}

/** 一个远程 server（streamable-http）+ 请求头 + 工具定义的条目。 */
async function seedRemoteMcpServer(): Promise<void> {
  await writeAsset({
    kind: "MCP",
    slug: "ac-inference-sh-mcp",
    displayName: "Inference.sh MCP",
    license: null,
    summaryZh: "来自 MCP 官方 registry 的 MCP server「ac.inference.sh/mcp」。",
    summarySource: "TEMPLATE",
    repoOwner: "pulsemcp",
    repoName: "mcp-servers",
    repoUrl: "https://github.com/pulsemcp/mcp-servers",
    sourceId: "mcp-registry",
    stars: 91817,
    detail: {
      mcp: {
        transport: "http",
        serverName: "ac.inference.sh/mcp",
        serverDescription: "MCP server for remote filesystem operations on cloud storage.",
        packages: [],
        remotes: [
          {
            type: "streamable-http",
            url: "https://api.inference.sh/mcp",
            headers: [{ name: "Authorization", isSecret: true, description: "Bearer token" }],
          },
        ],
        tools: [
          {
            name: "run_model",
            description: "跑一个模型。",
            inputSchema: {
              type: "object",
              properties: { prompt: { type: "string" } },
              required: ["prompt"],
            },
          },
        ],
        envVars: [],
        ports: [],
        configJson: {
          "ac.inference.sh/mcp": {
            type: "http",
            url: "https://api.inference.sh/mcp",
            headers: { Authorization: "<Authorization_在这里填你的值>" },
          },
        },
      },
    },
  });
}

describe("GET /api/mcp/{slug}", () => {
  it("返回工具定义：名称、描述与参数结构", async () => {
    await seedLocalMcpServer();

    const response = await getMcp(new Request("http://localhost/api/mcp/x"), {
      params: Promise.resolve({ slug: "com-pulsemcp-remote-filesystem" }),
    });

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.serverName).toBe("com.pulsemcp/remote-filesystem");
    expect(body.transport).toBe("stdio");
    expect(body.transportLabel).toContain("stdio");
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]).toMatchObject({
      name: "read_file",
      description: "读一个文件的内容。",
    });
    // 参数结构：名称、类型、是否必填、描述。
    expect(body.tools[0].params).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "path", type: "string", required: true }),
        expect.objectContaining({ name: "encoding", type: "string", required: false }),
      ]),
    );
  });

  it("返回环境变量清单并标注哪些必填、哪些是密钥", async () => {
    await seedLocalMcpServer();

    const response = await getMcp(new Request("http://localhost/api/mcp/x"), {
      params: Promise.resolve({ slug: "com-pulsemcp-remote-filesystem" }),
    });

    const body = await response.json();
    const byName = new Map(
      (body.envVars as { name: string }[]).map((variable) => [variable.name, variable]),
    );
    expect(byName.get("GCS_BUCKET")?.required).toBe(true);
    expect(byName.get("GCS_PRIVATE_KEY")?.secret).toBe(true);
    expect(byName.get("GCS_MAKE_PUBLIC")?.required).toBe(false);
    expect(byName.get("GCS_MAKE_PUBLIC")?.defaultValue).toBe("false");
  });

  it("返回仓库 star 与最近更新日期", async () => {
    await seedLocalMcpServer();

    const response = await getMcp(new Request("http://localhost/api/mcp/x"), {
      params: Promise.resolve({ slug: "com-pulsemcp-remote-filesystem" }),
    });

    const body = await response.json();
    expect(body.stars).toBe(81);
    expect(body.repoUrl).toBe("https://github.com/pulsemcp/mcp-servers");
    expect(body.repoPushedAt).toBe("2026-10-09T17:32:15.000Z");
    expect(body.publishedAt).toBe("2026-06-26T14:07:53.723Z");
    expect(body.license).toBeNull();
  });

  it("配置片段是合法的 mcpServers JSON：stdio 形态有 command + args", async () => {
    await seedLocalMcpServer();

    const response = await getMcp(new Request("http://localhost/api/mcp/x"), {
      params: Promise.resolve({ slug: "com-pulsemcp-remote-filesystem" }),
    });

    const body = await response.json();
    const parsed = JSON.parse(body.configText);
    const entry = parsed["com.pulsemcp/remote-filesystem"];
    expect(entry.command).toBe("npx");
    expect(entry.args).toEqual(["-y", "remote-filesystem-mcp-server"]);
    // env 的值用占位符而不是空串。
    expect(entry.env.GCS_BUCKET).toBe("<GCS_BUCKET>");
    expect(entry.env.GCS_PRIVATE_KEY).toBe("<GCS_PRIVATE_KEY_在这里填你的值>");
    expect(Object.values(entry.env).every((value) => value !== "")).toBe(true);
  });

  it("配置片段是合法的 mcpServers JSON：远程形态有 url", async () => {
    await seedRemoteMcpServer();

    const response = await getMcp(new Request("http://localhost/api/mcp/x"), {
      params: Promise.resolve({ slug: "ac-inference-sh-mcp" }),
    });

    const body = await response.json();
    const parsed = JSON.parse(body.configText);
    expect(parsed["ac.inference.sh/mcp"].url).toBe("https://api.inference.sh/mcp");
    expect(parsed["ac.inference.sh/mcp"].type).toBe("http");
  });

  it("METADATA_ONLY 档位下结构化字段照常保留（正文被清空是设计如此）", async () => {
    await seedLocalMcpServer();

    const response = await getMcp(new Request("http://localhost/api/mcp/x"), {
      params: Promise.resolve({ slug: "com-pulsemcp-remote-filesystem" }),
    });

    const body = await response.json();
    expect(body.contentTier).toBe("METADATA_ONLY");
    // 工具定义、环境变量、配置片段都不受许可证分层影响。
    expect(body.tools).toHaveLength(1);
    expect(body.envVars).toHaveLength(3);
    expect(Object.keys(body.config)).toHaveLength(1);
  });

  it("不存在的 slug 返回 404", async () => {
    const response = await getMcp(new Request("http://localhost/api/mcp/x"), {
      params: Promise.resolve({ slug: "not-there" }),
    });

    expect(response.status).toBe(404);
  });
});

describe("/mcp 列表页", () => {
  it("列出已收录的 MCP server，并指向详情页", async () => {
    await seedLocalMcpServer();
    await seedRemoteMcpServer();

    const element = await McpListPage({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(element);

    expect(html).toContain('href="/mcp/com-pulsemcp-remote-filesystem"');
    expect(html).toContain('href="/mcp/ac-inference-sh-mcp"');
    expect(html).toContain("Remote Filesystem MCP");
  });

  it("只列 MCP，不列 Skill", async () => {
    await seedLocalMcpServer();
    await writeAsset({
      kind: "SKILL",
      slug: "some-skill",
      displayName: "某个 Skill",
      license: "MIT",
      summaryZh: "某个 Skill",
      summarySource: "TEMPLATE",
    });

    const element = await McpListPage({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("/mcp/com-pulsemcp-remote-filesystem");
    expect(html).not.toContain("/skills/some-skill");
  });
});

describe("/mcp/{slug} 详情页", () => {
  it("展示工具定义、环境变量、传输方式与配置片段", async () => {
    await seedLocalMcpServer();

    const element = await McpDetailPage({
      params: Promise.resolve({ slug: "com-pulsemcp-remote-filesystem" }),
    });
    const html = renderToStaticMarkup(element);

    // 工具：名称 + 描述 + 参数。
    expect(html).toContain("read_file");
    expect(html).toContain("读一个文件的内容。");
    expect(html).toContain("path");
    expect(html).toContain("encoding");
    expect(html).toContain("必填");

    // 环境变量：清单 + 必填标记。
    expect(html).toContain("GCS_BUCKET");
    expect(html).toContain("GCS_PRIVATE_KEY");
    expect(html).toContain("密钥");

    // 传输方式与配置片段。
    expect(html).toContain("stdio");
    expect(html).toContain("remote-filesystem-mcp-server");
    expect(html).toContain("mcpServers");
  });
});

describe("统一搜索能命中 MCP 条目", () => {
  it("/api/search 按关键词返回 MCP 条目", async () => {
    await seedLocalMcpServer();

    const response = await searchApi(new Request("http://localhost/api/search?q=filesystem"));

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({
      slug: "com-pulsemcp-remote-filesystem",
      kind: "MCP",
    });
    expect(body.facets.kind).toEqual(
      expect.arrayContaining([{ value: "MCP", count: 1 }]),
    );
  });

  it("/search 页面把 MCP 结果指向 /mcp/{slug}", async () => {
    await seedLocalMcpServer();

    const element = await SearchPage({ searchParams: Promise.resolve({ q: "filesystem" }) });
    const html = renderToStaticMarkup(element);

    expect(html).toContain('href="/mcp/com-pulsemcp-remote-filesystem"');
  });

  it("MCP 条目能被 kind 过滤单独筛出来", async () => {
    await seedLocalMcpServer();
    await writeAsset({
      kind: "SKILL",
      slug: "filesystem-skill",
      displayName: "filesystem 技能",
      license: "MIT",
      summaryZh: "filesystem 技能",
      summarySource: "TEMPLATE",
    });

    const response = await searchApi(
      new Request("http://localhost/api/search?q=filesystem&kind=MCP"),
    );

    const body = await response.json();
    expect(body.total).toBe(1);
    expect(body.items[0].kind).toBe("MCP");
  });
});
