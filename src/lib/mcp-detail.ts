/**
 * MCP 详情页 / 详情接口共用的视图模型（票 #13）。
 *
 * 与 {@link ../lib/asset-detail} 里 Skill 的那一套同构：页面与接口读**同一份**
 * 视图模型，所以「页面上显示的」与「接口返回的」天然一致 ——
 * 一键复制要「与原文逐字一致」，这条保证不能靠两边各写一遍再对齐。
 *
 * ## 字段从哪儿来
 *
 * - 主表（`Asset`）：名称、许可证、star、热度、发布时间、站内更新时间；
 * - 扩展表（`McpDetail`）：传输方式、packages / remotes 声明、工具定义、
 *   环境变量、端口、`mcpServers` 配置片段。
 *
 * ⚠️ MCP 条目一律 METADATA_ONLY（registry 不声明许可证），所以 `contentBody`
 *    被数据库触发器清空是**设计如此**，不是 bug：MCP 的「正文」是 server 自己的
 *    README / 源码，站内不取；工具定义、环境变量、传输方式、配置片段都存在
 *    结构化字段里，照常展示。
 */
import type { ContentTier, SummarySource } from "@prisma/client";

import { getAssetBySlug } from "@/lib/asset-query";

/** 工具的一个参数（从 JSON Schema 摊平出来）。 */
export type McpToolParamView = {
  name: string;
  /// 参数类型（string / number / array / object …）。
  type: string;
  /// 是否必填。
  required: boolean;
  description: string | null;
  /// 可选值（JSON Schema 的 enum）。
  choices: string[];
  /// 默认值。
  defaultValue: string | null;
};

/** 一个工具定义。 */
export type McpToolView = {
  name: string;
  description: string | null;
  /// 参数结构（摊平后的参数清单）。
  params: McpToolParamView[];
  /// 原始的 JSON Schema（inputSchema），保留给想看原始结构的场合。
  inputSchema: unknown | null;
};

/** 一个环境变量。 */
export type McpEnvVarView = {
  name: string;
  /// 是否必填。
  required: boolean;
  /// 是否是密钥。
  secret: boolean;
  description: string | null;
  defaultValue: string | null;
  /// 来自哪个包。
  source: string | null;
};

/** MCP 详情视图。 */
export type McpDetailView = {
  slug: string;
  displayName: string;
  /// registry 里的原始 server 名（reverse-DNS）。
  serverName: string;
  /// 上游版本号。
  serverVersion: string;
  summaryZh: string | null;
  summarySource: SummarySource | null;
  /// registry 给的原始描述（详情页展示，不进可检索字段）。
  description: string | null;
  license: string | null;
  contentTier: ContentTier;
  /// 传输方式：stdio / http / sse / unknown。
  transport: string;
  /// 传输方式的展示名。
  transportLabel: string;
  repoOwner: string | null;
  repoName: string | null;
  repoUrl: string | null;
  upstreamUrl: string | null;
  stars: number;
  heatScore: number;
  favoriteCount: number;
  likeCount: number;
  sourceId: string | null;
  /// 上游发布时间。
  publishedAt: Date | null;
  /// 站内最近更新（写入时间）。
  updatedAt: Date;
  /// 站内最近一次采集时间。
  lastSyncedAt: Date | null;
  /// 来源仓库最近一次推送的时间（GitHub 的 pushed_at）。
  repoPushedAt: Date | null;
  /// registry 的 packages 声明（原样）。
  packages: unknown[];
  /// registry 的 remotes 声明（原样）。
  remotes: unknown[];
  /// 工具定义（可能为空数组 = 没取到）。
  tools: McpToolView[];
  /// 是否真的取到了工具定义（false = 连不上 / 要凭据，详情页要说明）。
  toolsAvailable: boolean;
  /// 环境变量清单。
  envVars: McpEnvVarView[];
  /// 声明的端口。
  ports: number[];
  /// `mcpServers` 配置片段（server 名 → 配置项）。
  config: Record<string, unknown>;
  /// 配置片段的文本形态（一键复制直接用它）。
  ///
  /// ⚠️ 这里带的是**完整的** `{ "mcpServers": { ... } }` 对象，不是里面的 map：
  ///    验收要求「复制出的配置片段能直接粘进客户端使用」——
  ///    用户粘进 `claude_desktop_config.json` / `cursor.json` 这类配置文件时，
  ///    客户端认的是顶层 `mcpServers` 键；只给内层 map 的话，
  ///    用户还得自己手动包一层，不能算「直接粘」。
  configText: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 传输方式的展示名。 */
function transportLabel(transport: string): string {
  switch (transport) {
    case "stdio":
      return "本地 stdio（子进程）";
    case "http":
      return "远程 HTTP（streamable-http）";
    case "sse":
      return "远程 SSE";
    default:
      return "未声明传输方式";
  }
}

/**
 * 把 JSON Schema 摊平成参数清单。
 *
 * 只认 `properties` + `required` 这两个最常见的形状；摊不动的（oneOf / anyOf 之类）
 * 就原样留着 inputSchema，参数清单给空数组 —— 不猜。
 */
export function flattenInputSchema(inputSchema: unknown): McpToolParamView[] {
  const schema = asRecord(inputSchema);
  if (!schema) {
    return [];
  }
  const properties = asRecord(schema.properties);
  if (!properties) {
    return [];
  }
  const required = Array.isArray(schema.required)
    ? schema.required.filter((value): value is string => typeof value === "string")
    : [];

  const out: McpToolParamView[] = [];
  for (const [name, raw] of Object.entries(properties)) {
    const property = asRecord(raw);
    out.push({
      name,
      type: typeof property?.type === "string" ? property.type : "unknown",
      required: required.includes(name),
      description: typeof property?.description === "string" ? property.description : null,
      choices: Array.isArray(property?.enum)
        ? property.enum.filter((value): value is string => typeof value === "string")
        : [],
      defaultValue:
        property?.default === undefined || property?.default === null
          ? null
          : String(property.default),
    });
  }
  return out;
}

/** 工具清单（`McpDetail.tools`）→ 视图模型。 */
export function toToolViews(tools: unknown): McpToolView[] {
  return asArray(tools)
    .map((raw): McpToolView | null => {
      const tool = asRecord(raw);
      if (!tool || typeof tool.name !== "string") {
        return null;
      }
      return {
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : null,
        params: flattenInputSchema(tool.inputSchema),
        inputSchema: tool.inputSchema ?? null,
      };
    })
    .filter((tool): tool is McpToolView => tool !== null);
}

/** 环境变量清单：优先读 packages 里的完整声明，退回 `envVars` 里的名字。 */
export function toEnvVarViews(packages: unknown[], envVarNames: string[]): McpEnvVarView[] {
  const out: McpEnvVarView[] = [];
  const seen = new Set<string>();

  for (const raw of packages) {
    const pkg = asRecord(raw);
    if (!pkg) continue;
    const identifier = typeof pkg.identifier === "string" ? pkg.identifier : null;
    for (const rawVariable of asArray(pkg.environmentVariables)) {
      const variable = asRecord(rawVariable);
      if (!variable || typeof variable.name !== "string") continue;
      const key = `${identifier ?? ""}#${variable.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        name: variable.name,
        required: variable.isRequired === true,
        secret: variable.isSecret === true,
        description: typeof variable.description === "string" ? variable.description : null,
        defaultValue: typeof variable.default === "string" ? variable.default : null,
        source: identifier,
      });
    }
  }

  if (out.length === 0 && envVarNames.length > 0) {
    // 扩展表里只有名字（老数据 / 手工写入）：仍然把清单列出来。
    for (const name of envVarNames) {
      out.push({
        name,
        required: false,
        secret: false,
        description: null,
        defaultValue: null,
        source: null,
      });
    }
  }

  return out;
}

/**
 * 取一个 MCP server 的详情视图。
 *
 * 不是 MCP、或不存在，都返回 null。
 */
export async function getMcpDetail(slug: string): Promise<McpDetailView | null> {
  const asset = await getAssetBySlug(slug);
  if (!asset || asset.kind !== "MCP") {
    return null;
  }

  const detail = asset.mcpDetail;
  const packages = asArray(detail?.packages);
  const remotes = asArray(detail?.remotes);
  const tools = toToolViews(detail?.tools);
  const envVars = toEnvVarViews(packages, detail?.envVars ?? []);
  const config = asRecord(detail?.configJson) ?? {};
  const transport = detail?.transport ?? "unknown";

  return {
    slug: asset.slug,
    displayName: asset.displayName,
    serverName: detail?.serverName ?? asset.displayName,
    serverVersion: readServerVersion(packages),
    summaryZh: asset.summaryZh,
    summarySource: asset.summarySource,
    description: detail?.serverDescription ?? null,
    license: asset.license,
    contentTier: asset.contentTier,
    transport,
    transportLabel: transportLabel(transport),
    repoOwner: asset.repoOwner,
    repoName: asset.repoName,
    repoUrl: asset.repoUrl,
    upstreamUrl: asset.upstreamUrl,
    stars: asset.stars,
    heatScore: asset.heatScore,
    favoriteCount: asset.favoriteCount,
    likeCount: asset.likeCount,
    sourceId: asset.sourceId,
    publishedAt: asset.publishedAt,
    updatedAt: asset.updatedAt,
    lastSyncedAt: asset.lastSyncedAt,
    /// 来源仓库最近一次推送的时间。
    repoPushedAt: detail?.repoPushedAt ?? null,
    packages,
    remotes,
    tools,
    // ⚠️ 「没有工具」与「没取到工具」要分得清：数组为空但确实是取到了
    //    （server 真的没有工具）时 toolsAvailable 也算真。
    toolsAvailable: Array.isArray(detail?.tools),
    envVars,
    ports: detail?.ports ?? [],
    config,
    // 带顶层 `mcpServers` 键，粘进客户端的配置文件就能用（见 configText 的注释）。
    configText: JSON.stringify({ mcpServers: config }, null, 2),
  };
}

/**
 * 版本号。
 *
 * ⚠️ registry 的 `server.version` 没有单独存字段（`McpDetail` 里没有这一列），
 *    所以从 packages 的版本声明里取；取不到就显示「—」。
 */
function readServerVersion(packages: unknown[]): string {
  for (const raw of packages) {
    const pkg = asRecord(raw);
    if (pkg && typeof pkg.version === "string" && pkg.version.length > 0) {
      return pkg.version;
    }
  }
  return "—";
}
