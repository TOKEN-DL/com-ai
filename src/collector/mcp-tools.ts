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
 *
 * ⚠️ SSE 形态**不能**用 `response.text()`：streamable-http 的 server 发完响应
 *    之后**不会关流**（它在等下一条消息），`text()` 会一直等到超时。
 *    所以这里流式读，拿到目标 id 的那条消息就停。
 */
async function readJsonRpcPayload(
  response: Response,
  expectedId: number,
  timeoutMs: number,
): Promise<unknown> {
  const contentType = response.headers.get("content-type");
  if (contentType !== null && contentType.includes("text/event-stream")) {
    return readSseMessage(response, expectedId, timeoutMs);
  }
  const text = await readBodyText(response, timeoutMs);
  return tryParse(text);
}

/** 流式读 body，最多读 timeoutMs 毫秒。 */
async function readBodyText(response: Response, timeoutMs: number): Promise<string> {
  const body = response.body;
  if (!body) {
    return "";
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let text = "";

  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }
      const chunk = await raceWithTimeout(reader.read(), remaining);
      if (chunk === null) {
        break;
      }
      if (chunk.done) {
        break;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return text;
}

/**
 * 流式读 SSE，拿到 id 匹配的那条 JSON-RPC 消息就返回。
 *
 * SSE 的事件之间用空行分隔；`data:` 行是消息体（可能多行）。
 */
async function readSseMessage(
  response: Response,
  expectedId: number,
  timeoutMs: number,
): Promise<unknown> {
  const body = response.body;
  if (!body) {
    return null;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let buffer = "";

  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }
      const chunk = await raceWithTimeout(reader.read(), remaining);
      if (chunk === null || chunk.done) {
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      // ⚠️ 事件分隔符可能是 "\n\n" 也可能是 "\r\n\r\n"（不同 server 的实现不一样），
      //    统一成 "\n" 再找边界。
      buffer = buffer.replace(/\r\n/g, "\n");

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseSseEvent(raw);
        if (parsed !== null && isRecord(parsed) && parsed.id === expectedId) {
          return parsed;
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  // 流结束了但还没匹配上：把剩下的 buffer 当最后一条事件试试。
  const tail = parseSseEvent(buffer);
  if (tail !== null && isRecord(tail) && tail.id === expectedId) {
    return tail;
  }
  return null;
}

/** 读超时：到点就返回 null（而不是把整个采集挂住）。 */
async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** 一条 SSE 事件（`event:` / `data:` 行）→ JSON。 */
function parseSseEvent(raw: string): unknown {
  const data = raw
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((line) => line.length > 0)
    .join("");
  if (data.length === 0) {
    return null;
  }
  return tryParse(data);
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
    if (!response.ok) {
      return null;
    }
    const initializePayload = await readJsonRpcPayload(response, 1, timeoutMs);
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
    const response = await options.http(url, {
      method: "POST",
      headers: sessionId ? { ...JSONRPC_HEADERS, "mcp-session-id": sessionId } : JSONRPC_HEADERS,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      timeoutMs,
    });
    // 响应体没人读 —— 主动断掉，别把连接挂着。
    await response.body?.cancel().catch(() => undefined);
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
    const payload = await readJsonRpcPayload(response, 2, timeoutMs);
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
