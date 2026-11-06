/**
 * MCP 官方 registry 采集适配器（票 #13）。
 *
 * 端点事实（实测，见 .com-ai-context/verified-endpoints.md 第 1.4–1.8 节与
 * verified-prompt-mcp.md 第 4 节）：
 *   - 列表：`GET https://registry.modelcontextprotocol.io/v0/servers?limit={n}&version=latest`
 *     - `limit` 默认 30、最小 1、**最大 100**；分页用响应里的 `metadata.nextCursor`
 *       （形如 `com.pulsemcp/remote-filesystem:0.1.5`，**含斜杠，要编码**）。
 *     - ⚠️ **`version=latest` 必须带**：不带时前几条会是同一个 server 的历史版本
 *       （`isLatest=false`）。所以这里固定带，并且**入库前再校验一次**
 *       `_meta["io.modelcontextprotocol.registry/official"].isLatest === true`，
 *       不满足的条目直接丢弃（验收标准第 6 条：列表里不出现废弃版本）。
 *     - 免鉴权。
 *   - 权威字段清单：`GET /openapi.json`。
 *
 * 双路建模（实测 500 条样本）：
 *   - 有 `remotes` 443 条（88.6%）、有 `packages` 71 条（14.2%）、两者都有 17 条、
 *     **两者都没有 3 条**；有 `repository` 201 条（40.2%）。
 *   - 所以 `packages` 与 `remotes` **分别建模**，不假设其一必有。
 *
 * 结构变更必须显式失败：形状不对一律抛 {@link SourceStructureError}，
 * 绝不静默返回空数组。
 */
import { SourceConfigError, SourceStructureError } from "@/collector/errors";
import { computeHeatScore } from "@/collector/heat";
import { createHttpClient, fetchJson, type HttpClient } from "@/collector/http";
import {
  buildMcpServersConfig,
  buildMcpSlug,
  classifyTransport,
  collectEnvVars,
  collectPorts,
  parseGitHubSlug,
  type McpServerEntry,
  type McpTransportType,
} from "@/collector/mcp-config";
import { discoverRemoteTools, readPublisherTools, type McpTool } from "@/collector/mcp-tools";
import { fetchRepoStats, type RepoStats } from "@/collector/github-stars";
import type {
  FetchResult,
  McpRegistrySourceConfig,
  RawItem,
  SourceAdapter,
  SourceType,
} from "@/collector/types";

const MCP_REGISTRY_BASE = "https://registry.modelcontextprotocol.io";

/** registry 的单页最大条数（openapi 确认）。 */
const MAX_PAGE_LIMIT = 100;

/** registry 列表响应的形状。 */
type RegistryListResponse = {
  servers?: unknown;
  metadata?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 这一项是不是「最新版本」。
 *
 * ⚠️ registry 的 `_meta` 键名带斜杠，必须用 bracket 访问。
 *    `isLatest` 不为 true（缺字段 / 为 false）一律当作**不是最新版本**丢弃。
 */
export function isLatestEntry(entry: McpServerEntry): boolean {
  const meta = entry._meta?.["io.modelcontextprotocol.registry/official"];
  if (!isRecord(meta)) {
    return false;
  }
  return meta.isLatest === true;
}

/**
 * 校验一条 registry 条目的形状。
 *
 * 形状不对 = 上游改版了 → 抛 {@link SourceStructureError}（让人来看），
 * 不能当成「这条没有内容」悄悄丢掉。
 */
function assertEntryShape(value: unknown, index: number): McpServerEntry {
  if (!isRecord(value)) {
    throw new SourceStructureError(
      "mcp-registry",
      `第 ${index} 条不是对象：${JSON.stringify(value)?.slice(0, 120)}`,
    );
  }
  const server = value.server;
  if (!isRecord(server)) {
    throw new SourceStructureError("mcp-registry", `第 ${index} 条缺少 server 字段`);
  }
  if (typeof server.name !== "string" || server.name.length === 0) {
    throw new SourceStructureError("mcp-registry", `第 ${index} 条的 server.name 不是字符串`);
  }
  if (typeof server.version !== "string" || server.version.length === 0) {
    throw new SourceStructureError("mcp-registry", `第 ${index} 条的 server.version 不是字符串`);
  }
  if (server.description !== undefined && typeof server.description !== "string") {
    throw new SourceStructureError(
      "mcp-registry",
      `第 ${index} 条的 server.description 不是字符串`,
    );
  }
  if (server.packages !== undefined && !Array.isArray(server.packages)) {
    throw new SourceStructureError("mcp-registry", `第 ${index} 条的 server.packages 不是数组`);
  }
  if (server.remotes !== undefined && !Array.isArray(server.remotes)) {
    throw new SourceStructureError("mcp-registry", `第 ${index} 条的 server.remotes 不是数组`);
  }

  return {
    server: server as McpServerEntry["server"],
    _meta: isRecord(value._meta) ? value._meta : {},
  };
}

export type McpRegistryAdapterOptions = {
  /// 注入 HTTP 客户端（测试用 fixture 驱动；生产用默认的带容错实现）。
  http?: HttpClient;
  /// registry 根地址。
  base?: string;
  /// 查仓库 star 的实现（测试可注入假实现）。
  fetchStars?: (slugs: string[]) => Promise<Map<string, RepoStats>>;
  /// 探测工具定义的实现（测试可注入假实现）。
  discoverTools?: (url: string, transport: McpTransportType) => Promise<McpTool[] | null>;
  /// 工具探测的并发数。
  toolConcurrency?: number;
};

export class McpRegistryAdapter implements SourceAdapter<McpRegistrySourceConfig> {
  private readonly http: HttpClient;
  private readonly base: string;
  private readonly fetchStars: (slugs: string[]) => Promise<Map<string, RepoStats>>;
  private readonly discoverTools: (url: string, transport: McpTransportType) => Promise<McpTool[] | null>;
  private readonly toolConcurrency: number;

  constructor(options: McpRegistryAdapterOptions = {}) {
    this.http = options.http ?? createHttpClient();
    this.base = (options.base ?? MCP_REGISTRY_BASE).replace(/\/+$/, "");
    this.fetchStars =
      options.fetchStars ?? ((slugs) => fetchRepoStats(slugs, { http: this.http }));
    this.discoverTools =
      options.discoverTools ??
      ((url, transport) =>
        transport === "streamable-http"
          ? discoverRemoteTools(url, { http: this.http })
          : Promise.resolve(null));
    this.toolConcurrency = options.toolConcurrency ?? 8;
  }

  getName(): SourceType {
    return "mcp-registry";
  }

  validateConfig(config: McpRegistrySourceConfig): boolean {
    return Boolean(
      config &&
        config.type === "mcp-registry" &&
        (config.limit === undefined ||
          (Number.isFinite(config.limit) && config.limit > 0 && config.limit <= MAX_PAGE_LIMIT)) &&
        (config.maxServers === undefined ||
          (Number.isFinite(config.maxServers) && config.maxServers > 0)) &&
        (config.discoverTools === undefined || typeof config.discoverTools === "boolean") &&
        (config.maxToolProbes === undefined ||
          (Number.isFinite(config.maxToolProbes) && config.maxToolProbes >= 0)),
    );
  }

  async fetch(config: McpRegistrySourceConfig): Promise<FetchResult> {
    if (!this.validateConfig(config)) {
      throw new SourceConfigError(
        this.getName(),
        `配置不合法（limit 需在 1..${MAX_PAGE_LIMIT} 之间）：${JSON.stringify(config)}`,
      );
    }

    const limit = Math.min(config.limit ?? MAX_PAGE_LIMIT, MAX_PAGE_LIMIT);
    const maxServers = config.maxServers ?? 1_000;
    const discoverTools = config.discoverTools ?? true;
    const maxToolProbes = config.maxToolProbes ?? 200;

    const issues: string[] = [];
    const entries: McpServerEntry[] = [];
    let cursor: string | undefined;
    let skippedNotLatest = 0;
    let pages = 0;

    // ① 翻页拉取。
    while (entries.length < maxServers) {
      const params = new URLSearchParams();
      params.set("limit", String(limit));
      // ⚠️ 必须带 version=latest：不带会返回历史废弃版本。
      params.set("version", "latest");
      if (cursor) {
        params.set("cursor", cursor);
      }

      const url = `${this.base}/v0/servers?${params.toString()}`;
      const payload = await fetchJson<unknown>(this.http, url, {
        headers: { Accept: "application/json" },
      });

      const parsed = parseListResponse(payload);
      pages += 1;

      for (const raw of parsed.servers) {
        const entry = assertEntryShape(raw, entries.length);
        if (!isLatestEntry(entry)) {
          // 不是最新版本 = 废弃版本，**不入库**。
          skippedNotLatest += 1;
          continue;
        }
        entries.push(entry);
        if (entries.length >= maxServers) {
          break;
        }
      }

      // 结构变更的第一道闸门：整个第一页都没有一条最新版本 → 上游的 _meta 形状变了。
      if (pages === 1 && entries.length === 0 && parsed.servers.length > 0) {
        throw new SourceStructureError(
          this.getName(),
          "第一页里没有一条 isLatest=true 的条目（_meta 的形状可能变了）",
        );
      }

      if (!parsed.nextCursor || parsed.servers.length === 0) {
        break;
      }
      cursor = parsed.nextCursor;
    }

    if (entries.length === 0) {
      throw new SourceStructureError(this.getName(), "registry 没有返回任何可用条目");
    }

    // ② 仓库 star：一次 Search API 批量查。
    const repoSlugs: string[] = [];
    for (const entry of entries) {
      const slug = parseGitHubSlug(entry.server.repository);
      if (slug) {
        repoSlugs.push(slug);
      }
    }
    let stars = new Map<string, RepoStats>();
    if (repoSlugs.length > 0) {
      try {
        stars = await this.fetchStars([...new Set(repoSlugs)]);
      } catch (error) {
        // 热度拿不到**不阻塞入库**（票里明确：降级，不报错）。
        issues.push(
          `仓库 star 查询失败（不影响入库）：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // ③ 工具定义：对远程 server 做 MCP 握手。
    const toolsByName = new Map<string, McpTool[] | null>();
    if (discoverTools) {
      const targets = entries
        .filter((entry) => (entry.server.remotes ?? []).length > 0)
        .slice(0, maxToolProbes);
      let probed = 0;
      let succeeded = 0;
      for (const entry of targets) {
        const remote = entry.server.remotes?.[0];
        if (!remote?.url) {
          continue;
        }
        probed += 1;
        const tools = await this.discoverTools(remote.url, remote.type);
        if (tools && tools.length > 0) {
          succeeded += 1;
        }
        toolsByName.set(entry.server.name, tools);
      }
      if (probed > 0) {
        issues.push(`工具定义探测：${probed} 个远程 server，${succeeded} 个取到工具清单`);
      }
      if (targets.length < entries.filter((e) => (e.server.remotes ?? []).length > 0).length) {
        issues.push(`本轮只探测了前 ${targets.length} 个远程 server 的工具，其余留到下次`);
      }
    }

    // ④ 组装条目。
    const items: RawItem[] = [];
    const usedSlugs = new Set<string>();

    for (const entry of entries) {
      const server = entry.server;
      const repoSlug = parseGitHubSlug(server.repository);
      const repoStats = repoSlug ? stars.get(repoSlug.toLowerCase()) : undefined;

      const meta = isRecord(server._meta)
        ? server._meta["io.modelcontextprotocol.registry/official"]
        : undefined;
      const publishedAt = parseDate(
        isRecord(meta) ? meta.publishedAt : undefined,
      );
      const updatedAt = parseDate(isRecord(meta) ? meta.updatedAt : undefined);

      const config = buildMcpServersConfig(entry);
      const envVars = collectEnvVars(entry);
      const transport = classifyTransport(entry);

      const onlineTools = toolsByName.get(server.name) ?? null;
      const publisherTools = readPublisherTools(server._meta);
      const tools = onlineTools ?? (publisherTools.length > 0 ? publisherTools : null);

      let slug = buildMcpSlug(server.name);
      if (slug.length === 0) {
        slug = "mcp-server";
      }
      // slug 归一化后可能撞车（不同原名折成同一个短名），加后缀保证唯一。
      let unique = slug;
      let counter = 1;
      while (usedSlugs.has(unique)) {
        counter += 1;
        unique = `${slug}-${counter}`;
      }
      usedSlugs.add(unique);

      const starCount = repoStats?.stars ?? 0;
      const [owner, repoName] = repoSlug ? repoSlug.split("/") : [null, null];

      items.push({
        slug: unique,
        title: server.title ?? server.name,
        url:
          server.websiteUrl ??
          server.repository?.url ??
          `${this.base}/v0/servers/${encodeURIComponent(server.name)}/versions/${encodeURIComponent(server.version)}`,
        publishedAt,
        metadata: {
          kind: "MCP",
          sourceId: this.getName(),
          description: server.description ?? null,
          frontmatter: {},
          // ⚠️ registry 不声明每个 server 的许可证 → 一律 null（未声明许可证）。
          //    这不是缺陷：MCP 的「正文」是 server 自己的 README / 源码，站内不取；
          //    工具定义、环境变量、传输方式、配置片段都存在结构化字段里，照常存。
          license: null,
          repoOwner: owner ?? "",
          repoName: repoName ?? "",
          repoUrl: server.repository?.url ?? "",
          upstreamUrl: server.websiteUrl ?? server.repository?.url ?? null,
          skillPath: "",
          extraFiles: [],
          stars: starCount,
          installs: 0,
          heatScore: computeHeatScore({ installs: 0, stars: starCount }),
          isOfficial: false,
          mcp: {
            serverName: server.name,
            serverDescription: server.description ?? null,
            repoPushedAt: repoStats?.pushedAt ?? null,
            serverVersion: server.version,
            transport,
            packages: (server.packages ?? []) as unknown[],
            remotes: (server.remotes ?? []) as unknown[],
            tools: tools as unknown[] | null,
            envVars,
            ports: collectPorts(entry),
            config: config.mcpServers,
            configNotes: config.notes,
            publishedAt,
            updatedAt,
            repoSlug,
          },
        },
      });
    }

    if (skippedNotLatest > 0) {
      issues.unshift(`丢弃 ${skippedNotLatest} 条非最新版本（isLatest !== true）的条目`);
    }

    return {
      source: "mcp-registry:official",
      sourceType: this.getName(),
      items,
      error: issues.length > 0 ? issues.join("；") : undefined,
    };
  }
}

/** 解析列表响应。形状不对抛 {@link SourceStructureError}。 */
function parseListResponse(payload: unknown): {
  servers: unknown[];
  nextCursor?: string;
} {
  if (!isRecord(payload)) {
    throw new SourceStructureError("mcp-registry", "列表响应不是对象");
  }
  const response = payload as RegistryListResponse;
  if (!Array.isArray(response.servers)) {
    throw new SourceStructureError("mcp-registry", "列表响应的 servers 不是数组");
  }
  if (!isRecord(response.metadata)) {
    throw new SourceStructureError("mcp-registry", "列表响应的 metadata 不是对象");
  }
  const nextCursor = response.metadata.nextCursor;
  if (nextCursor !== undefined && typeof nextCursor !== "string") {
    throw new SourceStructureError("mcp-registry", "metadata.nextCursor 不是字符串");
  }
  return { servers: response.servers, ...(nextCursor ? { nextCursor } : {}) };
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
