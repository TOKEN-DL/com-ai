/**
 * MCP 工具发现的在线握手（票 #13）。
 *
 * registry 本身**不提供工具清单**（实测 `ServerJSON` 与 `openapi.json` 里都没有
 * tools 相关字段），所以工具定义只能真的去问那个 server：MCP 协议的 `tools/list`。
 *
 * 这里用录制的响应体驱动，一个网络请求都不打：
 *   - `application/json` 形态的响应；
 *   - `text/event-stream` 形态的响应（实测 deepwiki 就是这种）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { HttpClient } from "@/collector/http";
import { discoverRemoteTools, readPublisherTools } from "@/collector/mcp-tools";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp-registry");

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), "utf8");
}

type StubResponse = {
  status?: number;
  contentType?: string;
  body?: string;
  sessionId?: string;
};

function createStubHttp(
  handler: (url: string, init: { body?: string }) => StubResponse,
): { http: HttpClient; calls: { url: string; body?: string }[] } {
  const calls: { url: string; body?: string }[] = [];

  const http: HttpClient = async (url, init = {}) => {
    calls.push({ url, body: init.body });
    const stub = handler(url, init);
    return new Response(stub.body ?? "", {
      status: stub.status ?? 200,
      headers: {
        "Content-Type": stub.contentType ?? "application/json",
        ...(stub.sessionId ? { "mcp-session-id": stub.sessionId } : {}),
      },
    });
  };

  return { http, calls };
}

const TOOLS_URL = "https://example.com/mcp";

describe("MCP 工具发现 —— JSON 响应", () => {
  it("initialize 之后取到工具清单（名称 / 描述 / 参数结构）", async () => {
    const { http, calls } = createStubHttp((_url, init) => {
      const body = init.body ?? "";
      if (body.includes('"method":"initialize"')) {
        return {
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } },
          }),
          sessionId: "sess-1",
        };
      }
      if (body.includes('"method":"tools/list"')) {
        return { body: fixture("tools-list-response.json") };
      }
      return { status: 202, body: "" };
    });

    const tools = await discoverRemoteTools(TOOLS_URL, { http });

    expect(tools).not.toBeNull();
    expect(tools).toHaveLength(2);
    expect(tools?.[0]).toMatchObject({ name: "list_courses", description: "List published courses." });
    // 参数结构 = JSON Schema 的 properties + required。
    expect(tools?.[1]).toMatchObject({ name: "list_lessons" });
    const schema = tools?.[1]?.inputSchema as {
      properties: Record<string, { type: string; description?: string }>;
      required: string[];
    };
    expect(Object.keys(schema.properties)).toEqual(["course", "limit", "mode"]);
    expect(schema.required).toEqual(["course"]);

    // 握手顺序：initialize → notifications/initialized → tools/list。
    expect(calls).toHaveLength(3);
    expect(calls[0]?.body).toContain('"method":"initialize"');
    expect(calls[1]?.body).toContain("notifications/initialized");
    expect(calls[2]?.body).toContain('"method":"tools/list"');
  });
});

describe("MCP 工具发现 —— SSE 响应", () => {
  it("text/event-stream 的响应也能解析出工具清单", async () => {
    const { http } = createStubHttp((_url, init) => {
      const body = init.body ?? "";
      if (body.includes('"method":"initialize"')) {
        return {
          contentType: "text/event-stream",
          body: 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"capabilities":{}}}\n\n',
        };
      }
      if (body.includes('"method":"tools/list"')) {
        return {
          contentType: "text/event-stream",
          body: fixture("tools-list-sse.txt"),
        };
      }
      return { status: 202, body: "" };
    });

    const tools = await discoverRemoteTools(TOOLS_URL, { http });

    expect(tools).toHaveLength(1);
    expect(tools?.[0]).toMatchObject({
      name: "ask_wiki_question",
      description:
        "Ask any question about a GitHub repository's codebase and get an AI-powered answer\ngrounded in its DeepWiki.",
    });
    const schema = tools?.[0]?.inputSchema as { required: string[] };
    expect(schema.required).toEqual(["repoName", "question"]);
  });
});

describe("MCP 工具发现 —— 拿不到就返回 null", () => {
  it("服务器返回 401（要凭据）：返回 null，不编造工具", async () => {
    const { http } = createStubHttp(() => ({ status: 401, body: '{"error":"unauthorized"}' }));

    expect(await discoverRemoteTools(TOOLS_URL, { http })).toBeNull();
  });

  it("连不上（网络异常）：返回 null", async () => {
    const http: HttpClient = async () => {
      throw new Error("fetch failed");
    };

    expect(await discoverRemoteTools(TOOLS_URL, { http })).toBeNull();
  });

  it("响应形状不是 tools/list 的结果：返回 null", async () => {
    const { http } = createStubHttp((_url, init) => {
      if ((init.body ?? "").includes('"method":"initialize"')) {
        return { body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) };
      }
      return { body: JSON.stringify({ jsonrpc: "2.0", id: 2, result: { notTools: [] } }) };
    });

    expect(await discoverRemoteTools(TOOLS_URL, { http })).toBeNull();
  });
});

describe("发布者自报的工具清单（降级来源）", () => {
  it("_meta 里的 tools 数组能被读出来（只有名称与描述）", () => {
    const tools = readPublisherTools({
      "io.modelcontextprotocol.registry/publisher-provided": {
        tools: [{ name: "search_merchants", description: "筛选商家" }],
      },
    });

    expect(tools).toEqual([
      { name: "search_merchants", description: "筛选商家", inputSchema: null },
    ]);
  });

  it("没有 publisher-provided 时返回空数组", () => {
    expect(readPublisherTools(undefined)).toEqual([]);
    expect(readPublisherTools({})).toEqual([]);
  });
});
