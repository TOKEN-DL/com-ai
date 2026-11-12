/**
 * 采集器契约（spec 决策 4「采集器框架」）。
 *
 * 契约一句话：**输入源配置 → 输出规范化条目数组**。
 *
 * 形状抄自 `delong-hot-monitor/lib/sources/base.ts` 的 `SourceAdapter` / `RawItem` /
 * `FetchResult`，字段换成本项目需要的资产模型：
 *   - `RawItem.metadata` 承载规范化后的结构化字段（许可证、frontmatter、附属文件…），
 *     顶层只留「站点身份三件套」（slug / title / url）与正文；
 *   - `FetchResult.error` **只记非致命问题**（个别条目取回失败、树被截断…）。
 *     致命问题（网络失败、源结构变更、配置不合法）一律 **抛出**，不塞进 error 里。
 *
 * 为什么这样切：**结构变更必须显式失败**。上游改版时如果静默返回空数组，
 * 采集器会安静地采到 0 条，运维看不出是「这批源本来就没数据」还是「解析炸了」。
 */
import type { AssetKind, PromptModality } from "@prisma/client";

/** GitHub 仓库回源配置。 */
export type GitHubRepoSourceConfig = {
  type: "github-repo";
  /// 仓库 owner，如 "vercel-labs"。
  owner: string;
  /// 仓库名，如 "skills"。
  repo: string;
  /// 分支或 commit sha；省略则用仓库默认分支。
  branch?: string;
  /// 只采这一个 SKILL.md（仓库内相对路径）；省略则采仓库内全部 SKILL.md。
  skillPath?: string;
};

/** skills.sh 目录来源配置（票 #6）。 */
export type SkillsShSourceConfig = {
  type: "skills-sh";
  /**
   * 目录来源：
   *   - `leaderboard` —— 首页榜单（SSR 内嵌 `initialSkills`，带 installs 与 8 周趋势）；
   *   - `sitemap` —— 站点地图（只有 owner/repo/skillId，没有热度）。
   *
   * 两个目录的节奏不同，所以是两个独立 cron，不是统一轮询。
   */
  catalog: "leaderboard" | "sitemap";
};

/** 采集源配置（判别联合）。新增采集源时在这里加一个成员即可。 */
export type SourceConfig =
  | GitHubRepoSourceConfig
  | SkillsShSourceConfig
  | McpRegistrySourceConfig
  | PromptRepoSourceConfig;

/**
 * Prompt 语料源配置（票 #15）。
 *
 * 语料源是**声明式**的（见 `src/collector/prompt-sources.ts` 的目录），
 * 配置里只给源标识 —— 这样「有哪些源、各自什么许可证、什么模态、
 * 哪些文件是 prompt」只有一份事实来源，不会散落在配置与代码两处。
 */
export type PromptRepoSourceConfig = {
  type: "prompt-repo";
  /** 语料源标识（如 `f/prompts.chat`）。 */
  source: string;
};

/** MCP 官方 registry 来源配置（票 #13）。 */
export type McpRegistrySourceConfig = {
  type: "mcp-registry";
  /**
   * 每页条数。registry 的上限是 100（openapi 确认）。
   * 不给则用 100 —— 少请求几次，省配额。
   */
  limit?: number;
  /**
   * 本次最多采多少个 server（分页上限）。
   *
   * 用来给「工具定义探测」这种重活设个闸门：先把目录采全，
   * 工具探测每轮只做前 N 个，剩下的下一轮再来。
   */
  maxServers?: number;
  /** 是否探测工具定义（对远程 server 做 MCP 握手）。默认 true。 */
  discoverTools?: boolean;
  /** 本轮最多探测多少个远程 server 的工具定义。 */
  maxToolProbes?: number;
};

export type SourceType = SourceConfig["type"];

/** 附属文件（只存元数据，不存文件内容）。 */
export type ExtraFile = {
  /// 仓库内相对路径。
  path: string;
  /// 字节数；上游没给就是 null。
  size: number | null;
};

/** MCP 条目的结构化字段（`kind = "MCP"` 时才有值）。 */
export type McpItemMetadata = {
  /** registry 里的原始 server 名（reverse-DNS，如 `io.github.owner/server`）。 */
  serverName: string;
  /** registry 给的原始描述（详情页展示，不进可检索字段）。 */
  serverDescription: string | null;
  /** 来源仓库最近一次推送的时间（GitHub 的 pushed_at）。 */
  repoPushedAt: Date | null;
  /** 上游版本号（registry 的 `server.version`）。 */
  serverVersion: string;
  /** 传输方式：stdio / http / sse / unknown。 */
  transport: string;
  /** registry 的 packages 声明（原样存，供详情页展示环境变量与参数）。 */
  packages: unknown[];
  /** registry 的 remotes 声明（原样存）。 */
  remotes: unknown[];
  /** 探测到的工具定义；null = 没取到（连不上 / 要凭据）。 */
  tools: unknown[] | null;
  /** 环境变量清单（含必填 / 密钥标记）。 */
  envVars: {
    name: string;
    required: boolean;
    secret: boolean;
    description: string | null;
    defaultValue: string | null;
    source: string | null;
  }[];
  /** 声明的端口（#14 冲突检测的底座）。 */
  ports: number[];
  /** 可直接粘贴的 mcpServers 配置片段。 */
  config: Record<string, unknown>;
  /** 配置片段里「需要用户自己填什么」的提示。 */
  configNotes: { kind: string; target: string; message: string }[];
  /** 上游发布时间。 */
  publishedAt: Date | null;
  /** 上游最近更新时间。 */
  updatedAt: Date | null;
  /** 来源仓库（`owner/repo`）；没有仓库时是 null。 */
  repoSlug: string | null;
};

/** Prompt 条目的结构化字段（`kind = "PROMPT"` 时才有值）。 */
export type PromptItemMetadata = {
  /** 模态：文本 / 图片 / 视频 / 音乐。 */
  modality: PromptModality;
  /** 动作描述 / 标题（`f/prompts.chat` 的 act 字段）。 */
  act: string | null;
  /**
   * 提示词正文（**逐字原文**）。
   *
   * ⚠️ 与 `RawItem.content` 是同一段文本 —— 两处都存是为了让
   *    「Asset 主表正文（可检索）」与「PromptDetail 扩展表正文（展示用）」
   *    各有各的用处，且值必须一致。
   */
  promptBody: string | null;
  /** 面向开发者的说明。 */
  forDevs: string | null;
  /** 贡献者署名（上游自己声明的「谁贡献的」）。 */
  contributor: string | null;
  /** 工具 / 模型标签（Flux / Seedance / Suno …）。空数组 = 通用提示词。 */
  toolTags: string[];
  /**
   * 许可证要求的署名（作者 + 许可证标识 + 原仓库链接）。
   *
   * ⚠️ 与 `contributor` **不是一回事**：前者来自许可证（CC BY 4.0 必须署名），
   *    后者来自上游仓库。两者都不能替代对方。
   */
  attribution: string | null;
  /** 源文件在仓库内的相对路径（许可证 override 按它匹配）。 */
  sourcePath: string | null;
  /** 上游自己声明的许可证（override 之前；`NOASSERTION` 也如实记下）。 */
  detectedLicense: string | null;
};

/** 规范化条目的结构化字段。 */
export type RawItemMetadata = {
  /// 资产类型（当前只有 SKILL）。
  kind: AssetKind;
  /// 采集源标识，落进 Asset.sourceId。
  sourceId: string;
  /// 原始描述（frontmatter.description，原文，不翻译）。
  description: string | null;
  /// frontmatter 全量（YAML 解析结果）。
  frontmatter: Record<string, unknown>;
  /// SPDX 许可证 id；null = 上游没声明。
  license: string | null;
  repoOwner: string;
  repoName: string;
  /// 来源仓库的网页地址。
  repoUrl: string;
  /// 资产本体（原始 SKILL.md）的地址。
  /// 目录来源（skills.sh）在回源之前不知道这条地址，所以是 null。
  upstreamUrl: string | null;
  /// SKILL.md 在仓库内的相对路径。
  skillPath: string;
  /// 与 SKILL.md 同目录的附属文件清单。
  extraFiles: ExtraFile[];
  stars: number;
  installs: number;
  heatScore: number;
  isOfficial: boolean;
  /**
   * 目录来源给出的 skill 标识（skills.sh 的 `skillId`）。
   * GitHub 回源时没有这个概念，所以是可选项。
   */
  skillId?: string | null;
  /**
   * 近 8 周的周安装量（skills.sh 榜单给的趋势数据）。
   * 没有趋势数据时是空数组。
   */
  weeklyInstalls?: number[];
  /**
   * MCP 条目的结构化字段。
   *
   * 只有 `kind = "MCP"` 的条目才有它 —— 其它 kind 走 frontmatter 那条路。
   */
  mcp?: McpItemMetadata;
  /**
   * Prompt 条目的结构化字段。
   *
   * 只有 `kind = "PROMPT"` 的条目才有它。
   */
  prompt?: PromptItemMetadata;
};

/** 规范化条目。 */
export type RawItem = {
  /// 全站唯一短名（URL 片段）。
  slug: string;
  /// 展示名（英文原文名）。
  title: string;
  /// 资产本体地址。
  url: string;
  /// 正文原文。
  content?: string;
  publishedAt?: Date | null;
  metadata: RawItemMetadata;
};

/** 一次采集的结果。 */
export type FetchResult = {
  /// 采集源标识（配置级，如 "vercel-labs/skills"）。
  source: string;
  /// 采集源类型。
  sourceType: SourceType;
  /// 规范化条目数组。
  items: RawItem[];
  /**
   * **非致命**问题汇总（个别条目取回失败、树被截断、同名条目被去重…）。
   * 致命问题（网络失败 / 源结构变更 / 配置不合法）由 `fetch()` 直接抛出。
   */
  error?: string;
};

/** 采集适配器契约。 */
export interface SourceAdapter<TConfig extends SourceConfig = SourceConfig> {
  /// 采集源类型标识。
  getName(): string;
  /// 配置是否合法。非法配置在 `fetch()` 里直接抛错，不发请求。
  validateConfig(config: TConfig): boolean;
  /// 输入源配置，输出规范化条目数组。
  fetch(config: TConfig): Promise<FetchResult>;
}
