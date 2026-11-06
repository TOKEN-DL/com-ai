/**
 * MCP 工具定义的**在线发现**（票 #13）。
 *
 * ## 为什么需要它
 *
 * 官方 registry（`registry.modelcontextprotocol.io`）只给「server 的声明」——
 * 传输方式、包、远程端点、环境变量。**它不给工具清单**：
 * 实测 `ServerJSON` 的字段只有 `$schema / name / description / title / version /
 * packages / remotes / repository / websiteUrl / icons / _meta`，
 * `openapi.json` 的 `components.schemas` 里也只有 `ServerJSON / Package /
 * Transport / KeyValueInput / Argument …`，**没有任何 tools 相关的 schema 或端点**。
 *
 * 而验收标准要求「详情页展示的工具定义包含名称、描述与参数结构」。
 * 唯一能拿到权威工具定义的地方就是**真的去问那个 server**：
 * MCP 协议本身就有 `tools/list`，返回 `[{ name, description, inputSchema }]`，
 * `inputSchema` 就是 JSON Schema —— 参数结构。
 *
 * 实测（2026-11-06）：
 *   - `POST https://apexai.academy/mcp` → `initialize` 200 → `tools/list` 200，
 *     37 KB 的工具清单（带完整 inputSchema）；
 *   - `POST https://mcp.deepwiki.com/mcp` → 同上，响应是 `text/event-stream`；
 *   - `POST https://api.inference.sh/mcp` → **401**（要凭据）→ 拿不到工具。
 *
 * 所以：**能连上就有工具定义，连不上就留空**（详情页明确说明没取到），
 * 绝不编造。
 *
 * ## 只做 streamable-http
 *
 * 旧版 `sse` 传输要维持一条长连接 GET 流、再往另一个端点 POST 消息，
 * 实现复杂且极易挂死。实测 registry 里 `sse` 只占 6/443（约 1%），
 * 主流是 `streamable-http`（449/443），所以只覆盖后者，缺口在报告里如实说明。
 */
import { fetchJson, type HttpClient } from "@/collector/http";

/** 探测到的工具定义。 */
export type McpTool = {
  /// 工具名（调用时用的标识）。
  name: string;
  /// 工具描述（registry / server 自己写的）。
  description: string | null;
  /// 参数结构（JSON Schema）。server 没给就是 null。
  inputSchema: unknown | null;
};

export type ToolsDiscoveryOptions = {
  /// 注入 HTTP 客户端（测试用 fixture 驱动；生产用默认的带容错实现）。
  http: HttpClient;
  /// 单次请求超时（毫秒）。远程 server 可能很慢，默认给宽一点。
  timeoutMs?: number;
};

/** 单次探测的默认超时。 */
export const DEFAULT_TOOL_PROBE_TIMEOUT_MS = 20_000;

/** MCP 协议版本：向 server 宣告的版本。 */
const PROTOCOL_VERSION = "2025-06-18";

const JSONRPC_HEADERS = {
  "Content-Type": "application/json",
  // streamable-http 的响应可能是 JSON，也可能是 SSE，两种都要能收。
  Accept: "application/json, text/event-stream",
};

/**
 * 从响应里取出 JSON-RPC 的 `result`。
 *
 * 响应有两种形态（实测）：
 *   - `application/json`：`{"jsonrpc":"2.0","id":2,"result":{...}}`
 *   - `text/event-stream`：`event: message\ndata: {"jsonrpc":"2.0",...}`
 */
function extractJsonRpcResult(text: string, contentType: string | null): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (contentType !== null && contentType.includes("text/event-stream")) {
    // 取最后一条 data: 事件（一次响应可能带心跳等前置事件）。
    const dataLines = trimmed
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .filter((line) => line.length > 0);
    for (let i = dataLines.length - 1; i >= 0; i -= 1) {
      const parsed = tryParse(dataLines[i]);
      if (parsed !== null) {
        return parsed;
      }
    }
    return null;
  }

  return tryParse(trimmed);
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON-RPC 响应 → 工具清单。形状不对就返回 null（不是结构变更，是 server 的自由发挥）。 */
function toTools(payload: unknown): McpTool[] | null {
  if (!isRecord(payload)) {
    return null;
  }
  const result = payload.result;
  if (!isRecord(result)) {
    return null;
  }
  const tools = result.tools;
  if (!Array.isArray(tools)) {
    return null;
  }

  const out: McpTool[] = [];
  for (const tool of tools) {
    if (!isRecord(tool) || typeof tool.name !== "string" || tool.name.length === 0) {
      continue;
    }
    out.push({
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : null,
      inputSchema: tool.inputSchema ?? null,
    });
  }
  return out;
}

/**
 * 对一个远程 MCP server 做 `initialize` → `tools/list` 握手，取回工具定义。
 *
 * 返回 null 表示**没取到**（连不上 / 要凭据 / 不是 MCP server），
 * 调用方据此把 `tools` 留空，绝不用空数组冒充「这个 server 没有工具」。
 */
export async function discoverRemoteTools(
  url: string,
  options: ToolsDiscoveryOptions,
): Promise<McpTool[] | null> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TOOL_PROBE_TIMEOUT_MS;

  // ① initialize：拿协议版本与（可能有）会话 id。
  let sessionId: string | null = null;
  try {
    const response = await options.http(url, {
      method: "POST",
      headers: JSONRPC_HEADERS,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "com-ai-collector", version: "1.0.0" },
        },
      }),
      timeoutMs,
    });

    sessionId = response.headers.get("mcp-session-id");
    const initializeText = await response.text();
    if (!response.ok) {
      return null;
    }
    // 握手本身失败（返回 error）就不继续了。
    const initializePayload = extractJsonRpcResult(initializeText, response.headers.get("content-type"));
    if (isRecord(initializePayload) && initializePayload.error) {
      return null;
    }
  } catch {
    // 连不上 / 超时 / 证书错误 —— 拿不到工具，走降级路径。
    return null;
  }

  // ② notifications/initialized：告诉 server 握手完成。
  //    有些 server 不回响应，失败也不该中断后面的 tools/list。
  try {
    await options.http(url, {
      method: "POST",
      headers: sessionId ? { ...JSONRPC_HEADERS, "mcp-session-id": sessionId } : JSONRPC_HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      timeoutMs,
    });
  } catch {
    // 忽略。
  }

  // ③ tools/list。
  try {
    const response = await options.http(url, {
      method: "POST",
      headers: sessionId ? { ...JSONRPC_HEADERS, "mcp-session-id": sessionId } : JSONRPC_HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      timeoutMs,
    });
    if (!response.ok) {
      return null;
    }
    const text = await response.text();
    const payload = extractJsonRpcResult(text, response.headers.get("content-type"));
    return toTools(payload);
  } catch {
    return null;
  }
}

/**
 * 从 registry 的 `_meta` 里取发布者自己声明的工具清单（降级来源）。
 *
 * 少数 server 会在 `io.modelcontextprotocol.registry/publisher-provided` 里
 * 放一个 `tools` 数组（只有 name + description，没有参数结构）。
 * 拿不到在线握手的结果时用它兜底，至少让详情页有东西可展示。
 */
export function readPublisherTools(entryMeta: Record<string, unknown> | undefined): McpTool[] {
  if (!entryMeta) {
    return [];
  }
  const provided = entryMeta["io.modelcontextprotocol.registry/publisher-provided"];
  if (!isRecord(provided)) {
    return [];
  }

  // 这个键的形状不固定：有时是 { tools: [...] }，有时是 { <namespace>: { tools: [...] } }。
  const candidates: unknown[] = [];
  if (Array.isArray(provided.tools)) {
    candidates.push(provided.tools);
  }
  for (const value of Object.values(provided)) {
    if (isRecord(value) && Array.isArray(value.tools)) {
      candidates.push(value.tools);
    }
  }

  const out: McpTool[] = [];
  for (const list of candidates) {
    for (const tool of list as unknown[]) {
      if (!isRecord(tool) || typeof tool.name !== "string" || tool.name.length === 0) {
        continue;
      }
      out.push({
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : null,
        inputSchema: null,
      });
    }
  }
  return out;
}

/** 导出一个便于测试的 JSON 抓取辅助（保持与 fetchJson 同一套错误语义）。 */
export { fetchJson };
