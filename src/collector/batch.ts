/**
 * 批量采集编排（票 #6）。
 *
 * 目录来源（skills.sh 榜单 / 站点地图）只告诉我们「有哪些 skill、来自哪个仓库、
 * 热度多少」；**正文仍然回源 GitHub** 拿原始 `SKILL.md` 与 frontmatter。
 * 这一层把两件事接起来：
 *
 *   1. 目录条目按仓库分组（同一个仓库只回源一次）；
 *   2. 每个仓库用 GitHub 适配器取回真实条目；
 *   3. 把目录里的热度（installs / 8 周趋势 / 官方标记）**贴回**对应条目；
 *   4. 算热度分。
 *
 * ⚠️ 单个仓库失败**不阻塞**其它仓库（与「单源异常不阻塞其它源」同一条原则）：
 *    失败的仓库记进报告，采集继续，最后一起入库。
 *
 * 这一层不碰数据库：纯编排，方便用录制的 fixture 测（seam 1）。
 * 入库、运行记录、告警在 {@link ../collector/collection-run} 那层做。
 */
import { computeHeatScore } from "@/collector/heat";
import type {
  FetchResult,
  GitHubRepoSourceConfig,
  RawItem,
  SourceAdapter,
  SourceConfig,
} from "@/collector/types";

/** 一个目录来源。 */
export type BatchSourceSpec = {
  /// 采集源标识（用于运行记录与告警），如 "skills.sh:leaderboard"。
  id: string;
  /// 目录适配器（skills.sh 适配器）。
  adapter: SourceAdapter;
  /// 目录适配器的配置。
  config: SourceConfig;
};

export type BatchOptions = {
  sources: BatchSourceSpec[];
  /// 回源 GitHub 的适配器。
  github: SourceAdapter<GitHubRepoSourceConfig>;
  /// 每个目录来源最多回源多少个仓库（限流保护）。
  maxRepos?: number;
  /// 仓库之间的等待间隔（毫秒）—— 对外站保持低压。
  repoDelayMs?: number;
  /// 可注入的等待（测试不用真等）。
  sleep?: (ms: number) => Promise<void>;
};

export type RepoOutcome = {
  /// `owner/repo`。
  repo: string;
  ok: boolean;
  /// 这个仓库采到的条目数。
  items: number;
  error?: string;
};

export type BatchSourceReport = {
  /// 采集源标识。
  source: string;
  ok: boolean;
  /// 目录里有多少条。
  catalogItems: number;
  /// 回源了几个仓库。
  reposScanned: number;
  /// 失败的仓库数。
  reposFailed: number;
  /// 补齐正文与热度后的条目。
  items: RawItem[];
  /// 失败 / 警告信息。
  error?: string;
};

export type BatchReport = {
  sources: BatchSourceReport[];
  /// 所有来源的条目（按来源顺序拼接）。
  items: RawItem[];
  /// 失败的目录来源数。
  failures: number;
};

/** 目录索引：`owner/repo#归一化的 skillId` → 目录条目。 */
type CatalogIndex = Map<string, RawItem>;

/** 归一化标识：小写、非字母数字折成连字符。 */
export function normalizeIdentifier(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** SKILL.md 所在目录名（`skills/pdf/SKILL.md` → `pdf`）。 */
export function skillDirectoryName(skillPath: string): string {
  const segments = skillPath.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2) return "";
  return segments[segments.length - 2];
}

/**
 * 给 GitHub 条目找对应的目录条目。
 *
 * 匹配顺序（从强到弱）：
 *   1. frontmatter 的 name（榜单的 skillId 通常就是它）；
 *   2. SKILL.md 所在目录名（frontmatter 名字与目录不一致时兜底）。
 */
export function matchCatalogEntry(
  item: RawItem,
  index: CatalogIndex,
): RawItem | null {
  const repo = `${item.metadata.repoOwner}/${item.metadata.repoName}`;
  const candidates = [
    normalizeIdentifier(item.title),
    normalizeIdentifier(skillDirectoryName(item.metadata.skillPath)),
  ];
  for (const candidate of candidates) {
    if (candidate.length === 0) continue;
    const hit = index.get(`${repo}#${candidate}`);
    if (hit) return hit;
  }
  return null;
}

/**
 * 把目录里的热度贴回 GitHub 条目，并算热度分。
 *
 * 没匹配上目录的条目（仓库里有、榜单没收录的）也算进来：
 * 它们是**真实存在**的 Skill，安装量按 0 计，热度只由 star 数决定。
 */
export function enrichWithCatalog(item: RawItem, index: CatalogIndex): RawItem {
  const hit = matchCatalogEntry(item, index);
  const installs = hit?.metadata.installs ?? 0;
  const weeklyInstalls = hit?.metadata.weeklyInstalls ?? [];
  const isOfficial = hit?.metadata.isOfficial ?? false;

  return {
    ...item,
    metadata: {
      ...item.metadata,
      sourceId: hit?.metadata.sourceId ?? "skills.sh",
      installs,
      weeklyInstalls,
      isOfficial,
      heatScore: computeHeatScore({
        installs,
        stars: item.metadata.stars,
        weeklyInstalls,
      }),
    },
  };
}

function buildIndex(items: RawItem[]): CatalogIndex {
  const index: CatalogIndex = new Map();
  for (const item of items) {
    const skillId = item.metadata.skillId ?? item.title;
    const key = normalizeIdentifier(skillId);
    if (key.length === 0) continue;
    index.set(`${item.metadata.repoOwner}/${item.metadata.repoName}#${key}`, item);
  }
  return index;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 单个仓库的告警文字最多留这么多字，避免一个仓库刷屏。 */
const MAX_REPO_ERROR_CHARS = 400;
/** 整个来源的告警文字最多留这么多字（要进数据库与告警记录）。 */
const MAX_SOURCE_ERROR_CHARS = 2_000;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…（已截断）`;
}

/**
 * 跑一批目录来源。
 *
 * **不抛错**：任何单个来源 / 仓库的失败都被吞进报告里。
 */
export async function collectBatch(options: BatchOptions): Promise<BatchReport> {
  const { sources, github, maxRepos = 200, repoDelayMs = 0 } = options;
  const sleep = options.sleep ?? defaultSleep;

  const reports: BatchSourceReport[] = [];
  const allItems: RawItem[] = [];

  for (const spec of sources) {
    let catalog: FetchResult;
    try {
      catalog = await spec.adapter.fetch(spec.config);
    } catch (error) {
      reports.push({
        source: spec.id,
        ok: false,
        catalogItems: 0,
        reposScanned: 0,
        reposFailed: 0,
        items: [],
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const index = buildIndex(catalog.items);

    // 按仓库分组，保持目录里的出现顺序（热度高的仓库先回源）。
    const repoOrder: string[] = [];
    const seen = new Set<string>();
    for (const item of catalog.items) {
      const repo = `${item.metadata.repoOwner}/${item.metadata.repoName}`;
      if (seen.has(repo)) continue;
      seen.add(repo);
      repoOrder.push(repo);
    }

    const targets = repoOrder.slice(0, Math.max(0, maxRepos));
    const errors: string[] = [];
    const items: RawItem[] = [];
    let reposFailed = 0;

    for (let i = 0; i < targets.length; i += 1) {
      const repo = targets[i];
      if (i > 0 && repoDelayMs > 0) {
        await sleep(repoDelayMs);
      }

      const [owner, name] = repo.split("/");
      try {
        const result = await github.fetch({ type: "github-repo", owner, repo: name });
        for (const item of result.items) {
          items.push(enrichWithCatalog(item, index));
        }
        if (result.error) {
          errors.push(`${repo}：${truncate(result.error, MAX_REPO_ERROR_CHARS)}`);
        }
      } catch (error) {
        reposFailed += 1;
        errors.push(`${repo} 回源失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (repoOrder.length > targets.length) {
      errors.push(
        `本次只回源了前 ${targets.length} 个仓库（目录里有 ${repoOrder.length} 个），其余留到下次`,
      );
    }
    if (catalog.error) {
      errors.unshift(catalog.error);
    }

    reports.push({
      source: spec.id,
      ok: reposFailed === 0,
      catalogItems: catalog.items.length,
      reposScanned: targets.length,
      reposFailed,
      items,
      error: errors.length > 0 ? truncate(errors.join("；"), MAX_SOURCE_ERROR_CHARS) : undefined,
    });
    allItems.push(...items);
  }

  return {
    sources: reports,
    items: allItems,
    failures: reports.filter((report) => !report.ok).length,
  };
}
