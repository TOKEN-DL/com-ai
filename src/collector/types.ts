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
import type { AssetKind } from "@prisma/client";

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
export type SourceConfig = GitHubRepoSourceConfig | SkillsShSourceConfig;

export type SourceType = SourceConfig["type"];

/** 附属文件（只存元数据，不存文件内容）。 */
export type ExtraFile = {
  /// 仓库内相对路径。
  path: string;
  /// 字节数；上游没给就是 null。
  size: number | null;
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
