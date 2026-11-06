/**
 * 采集任务定义（票 #6）：cron 注册什么、每个任务干什么。
 *
 * **每个源独立 cron**（spec 决策 4）：高频源与低频源节奏不同，不做统一轮询。
 * 这里把「节奏」和「干什么」放在一起，worker 只负责按表调度。
 *
 * 默认节奏：
 *   - `skills.sh:leaderboard` —— 榜单是**高频源**（热度每天都在变），每天一次；
 *   - `skills.sh:sitemap`     —— 站点地图是**低频源**（目录变化很慢），每周一次；
 *   - `retention`             —— 保留策略每天跑一次（凌晨，避开整点）。
 *
 * 表达式可以用环境变量覆盖（见 {@link resolveSchedule}）。
 */
import { collectBatch } from "@/collector/batch";
import { createCachingHttpClient, DEFAULT_CACHE_DIR, DEFAULT_CACHE_TTL_MS } from "@/collector/cache";
import { GitHubRepoAdapter } from "@/collector/github";
import { createHttpClient } from "@/collector/http";
import { ingestItems } from "@/collector/ingest";
import { runRetention } from "@/collector/retention";
import { SkillsShAdapter } from "@/collector/skills-sh";
import type { CollectionTaskResult } from "@/collector/collection-run";
import type { GitHubRepoSourceConfig, SourceAdapter } from "@/collector/types";

/** 榜单：每天 03:17 跑一次（避开整点，错开别的服务）。 */
export const LEADERBOARD_SCHEDULE = "17 3 * * *";
/** 站点地图：每周一 03:43 跑一次。 */
export const SITEMAP_SCHEDULE = "43 3 * * 1";
/** 保留策略：每天 04:07 跑一次。 */
export const RETENTION_SCHEDULE = "7 4 * * *";

export type CollectionTaskDefinition = {
  /// 采集源标识（运行记录与告警都按它归集）。
  id: string;
  /// 采集源类型。
  sourceType: string;
  /// cron 表达式。
  schedule: string;
  /// 任务干什么。
  task: () => Promise<CollectionTaskResult>;
};

export type BuildTasksOptions = {
  /// 目录适配器（测试可注入假实现）。
  catalogAdapter?: SourceAdapter;
  /// 回源适配器（测试可注入假实现）。
  githubAdapter?: SourceAdapter<GitHubRepoSourceConfig>;
  /// 榜单源最多回源多少个仓库。
  leaderboardMaxRepos?: number;
  /// 站点地图源最多回源多少个仓库。
  sitemapMaxRepos?: number;
  /// 仓库之间的等待间隔（毫秒）。
  repoDelayMs?: number;
  /// 榜单源的 cron 表达式。
  leaderboardSchedule?: string;
  /// 站点地图源的 cron 表达式。
  sitemapSchedule?: string;
  /// 保留策略的 cron 表达式。
  retentionSchedule?: string;
  /**
   * 只采集不��库（命令行 `--dry-run` 用）。
   *
   * ⚠️ 必须真的**不调** {@link ingestItems}：否则「dry-run」只是把
   *    报告里的入库条数改成 0，数据其实已经写进去了。
   */
  dryRun?: boolean;
};

/** 从环境变量读 cron 表达式；没给就用默认值。 */
export function resolveSchedule(envKey: string, fallback: string): string {
  const value = process.env[envKey];
  return value && value.trim().length > 0 ? value.trim() : fallback;
}

/** 环境变量里的上限；没给就用默认值。 */
function resolveNumber(envKey: string, fallback: number): number {
  const raw = process.env[envKey];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * 一个目录来源 → 一个采集任务。
 *
 * 任务内部：目录 → 回源 GitHub → 入库。返回的计数直接进运行记录。
 */
function createCatalogTask(options: {
  id: string;
  catalog: "leaderboard" | "sitemap";
  schedule: string;
  maxRepos: number;
  catalogAdapter: SourceAdapter;
  githubAdapter: SourceAdapter<GitHubRepoSourceConfig>;
  repoDelayMs: number;
  dryRun: boolean;
}): CollectionTaskDefinition {
  return {
    id: options.id,
    sourceType: "skills-sh",
    schedule: options.schedule,
    task: async (): Promise<CollectionTaskResult> => {
      const report = await collectBatch({
        sources: [
          {
            id: options.id,
            adapter: options.catalogAdapter,
            config: { type: "skills-sh", catalog: options.catalog },
          },
        ],
        github: options.githubAdapter,
        maxRepos: options.maxRepos,
        repoDelayMs: options.repoDelayMs,
      });

      const source = report.sources[0];
      if (!source) {
        return {
          fetched: 0,
          written: 0,
          failed: 0,
          failures: 1,
          error: "目录来源没有产出报告",
        };
      }

      const ingested = options.dryRun
        ? { written: 0, failed: 0 }
        : await ingestItems(source.items);
      // 子源（仓库）失败数：整批挂掉算 1 个，部分挂掉算挂掉的仓库数。
      const failures =
        source.reposFailed > 0 ? source.reposFailed : source.ok ? 0 : 1;
      return {
        fetched: source.items.length,
        written: ingested.written,
        failed: ingested.failed,
        failures,
        error: source.error ?? (ingested.failed > 0 ? `${ingested.failed} 条入库失败` : undefined),
      };
    },
  };
}

/** 构造要注册到调度器上的采集任务。 */
export function buildCollectionTasks(options: BuildTasksOptions = {}): CollectionTaskDefinition[] {
  const catalogAdapter = options.catalogAdapter ?? new SkillsShAdapter();
  const githubAdapter =
    options.githubAdapter ??
    new GitHubRepoAdapter({
      // 回源 GitHub 的请求**带缓存**（票 #6 验收标准第 7 条）：
      // 仓库元数据与 trees 占 GitHub API 配额（未认证 60 次/小时），
      // 缓存住就只花在真正变化的东西上。
      http: createCachingHttpClient({
        base: createHttpClient(),
        dir: process.env.COLLECTOR_CACHE_DIR ?? DEFAULT_CACHE_DIR,
        ttlMs: Number(process.env.COLLECTOR_CACHE_TTL_MS ?? DEFAULT_CACHE_TTL_MS),
      }),
    });

  return [
    createCatalogTask({
      id: "skills.sh:leaderboard",
      catalog: "leaderboard",
      schedule:
        options.leaderboardSchedule ??
        resolveSchedule("CRON_SKILLS_SH_LEADERBOARD", LEADERBOARD_SCHEDULE),
      maxRepos:
        options.leaderboardMaxRepos ??
        resolveNumber("SKILLS_SH_LEADERBOARD_MAX_REPOS", 200),
      catalogAdapter,
      githubAdapter,
      repoDelayMs: options.repoDelayMs ?? 0,
      dryRun: options.dryRun ?? false,
    }),
    createCatalogTask({
      id: "skills.sh:sitemap",
      catalog: "sitemap",
      schedule:
        options.sitemapSchedule ?? resolveSchedule("CRON_SKILLS_SH_SITEMAP", SITEMAP_SCHEDULE),
      maxRepos: options.sitemapMaxRepos ?? resolveNumber("SKILLS_SH_SITEMAP_MAX_REPOS", 300),
      catalogAdapter,
      githubAdapter,
      repoDelayMs: options.repoDelayMs ?? 0,
      dryRun: options.dryRun ?? false,
    }),
    createRetentionTask({
      schedule: options.retentionSchedule ?? resolveSchedule("CRON_RETENTION", RETENTION_SCHEDULE),
    }),
  ];
}

/**
 * 保留策略任务：热 → 归档 → 删除（spec 决策 4）。
 *
 * 每天跑一次，凌晨错开整点。
 */
function createRetentionTask(options: { schedule: string }): CollectionTaskDefinition {
  return {
    id: "retention",
    sourceType: "retention",
    schedule: options.schedule,
    task: async (): Promise<CollectionTaskResult> => {
      const report = await runRetention();
      console.log(`[retention] ${JSON.stringify(report)}`);
      return {
        // 「采到」= 检查到的资产数；「写入」= 本次归档的数量。
        fetched: report.scanned,
        written: report.archived,
        failed: 0,
        failures: 0,
      };
    },
  };
}
