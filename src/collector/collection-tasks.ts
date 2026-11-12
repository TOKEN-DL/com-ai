/**
 * 采集任务定义（票 #6）：cron 注册什么、每个任务干什么。
 *
 * **每个源独立 cron**（spec 决策 4）：高频源与低频源节奏不同，不做统一轮询。
 * 这里把「节奏」和「干什么」放在一起，worker 只负责按表调度。
 *
 * 默认节奏：
 *   - `skills.sh:leaderboard` —— 榜单是**高频源**（热度每天都在变），每天一次；
 *   - `skills.sh:sitemap`     —— 站点地图是**低频源**（目录变化很慢），每周一次；
 *   - `retention`             —— 保留策略每天跑一次（凌晨，避开整点）；
 *   - `scenarios`             —— 场景卡片派生（票 #12），每天跑一次，
 *                                排在所有采集之后，把新采集到的资产补上场景卡片。
 *
 * 表达式可以用环境变量覆盖（见 {@link resolveSchedule}）。
 */
import { collectBatch } from "@/collector/batch";
import { createCachingHttpClient, DEFAULT_CACHE_DIR, DEFAULT_CACHE_TTL_MS } from "@/collector/cache";
import { GitHubRepoAdapter } from "@/collector/github";
import { createHttpClient } from "@/collector/http";
import { ingestItems } from "@/collector/ingest";
import { McpRegistryAdapter } from "@/collector/mcp-registry";
import { PromptRepoAdapter } from "@/collector/prompt-repo";
import { PROMPT_SOURCES } from "@/collector/prompt-sources";
import { runRetention } from "@/collector/retention";
import { SkillsShAdapter } from "@/collector/skills-sh";
import { collectFromSources, type SourceRequest } from "@/collector/pipeline";
import { GitHubVersionSource } from "@/collector/github-versions";
import {
  syncUpstreamVersions,
  type UpstreamVersionSource,
} from "@/collector/version-sync";
import {
  findLastScenarioRunStartedAt,
  pruneOrphanScenarioCards,
  regenerateScenarioCards,
  SCENARIO_TASK_SOURCE,
} from "@/lib/scenario-service";
import type { CollectionTaskResult } from "@/collector/collection-run";
import type {
  GitHubRepoSourceConfig,
  McpRegistrySourceConfig,
  PromptRepoSourceConfig,
  SourceAdapter,
} from "@/collector/types";

/** 榜单：每天 03:17 跑一次（避开整点，错开别的服务）。 */
export const LEADERBOARD_SCHEDULE = "17 3 * * *";
/** 站点地图：每周一 03:43 跑一次。 */
export const SITEMAP_SCHEDULE = "43 3 * * 1";
/** 保留策略：每天 04:07 跑一次。 */
export const RETENTION_SCHEDULE = "7 4 * * *";
/** MCP 官方 registry：每天 05:23 跑一次。 */
export const MCP_REGISTRY_SCHEDULE = "23 5 * * *";
/**
 * Prompt 语料库：每周一 06:11 跑一次。
 *
 * 为什么是每周而不是每天：语料源是**仓库里的静态文件**，
 * 变更是低频事件；而主力源 `f/prompts.chat/prompts.csv` 有 10 MB，
 * 每天拉一遍纯属浪费带宽。
 */
export const PROMPT_REPO_SCHEDULE = "11 6 * * 1";
/**
 * 场景卡片派生：每天 05:41 跑一次。
 *
 * 排在**产出 Skill 的采集任务之后**（榜单 03:17 / 站点地图 03:43 / 保留 04:07），
 * 这样新采到的 Skill 当天就带上卡片。
 *
 * ⚠️ 它排在 Prompt 语料库（06:11）**之前** —— 但这不是问题：
 *    派生只扫 `kind = "SKILL"`（见 `regenerateScenarioCards`），
 *    Prompt 不参与派生，晚一轮不影响。
 */
export const SCENARIO_SCHEDULE = "41 5 * * *";
/**
 * 上游版本同步：每天 06:23 跑一次。
 *
 * 排在**所有采集任务之后**（榜单 03:17 / 站点地图 03:43 / 保留 04:07 /
 * MCP 05:23 / 场景卡片 05:41 / Prompt 06:11），这样新采到的资产当轮就能记上版本，
 * 不必等到第二天。
 */
export const VERSION_SYNC_SCHEDULE = "23 6 * * *";

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
  /// MCP 官方 registry 的 cron 表达式。
  mcpSchedule?: string;
  /// 场景卡片派生的 cron 表达式。
  scenarioSchedule?: string;
  /// 上游版本同步的 cron 表达式。
  versionSyncSchedule?: string;
  /// 上游版本取数实现（测试注入 fixture 驱动的假实现）。
  versionSource?: UpstreamVersionSource;
  /// 一轮最多同步多少个资产的版本（GitHub 配额有限）。
  versionSyncMaxAssets?: number;
  /**
   * MCP 官方 registry 的适配器（测试可注入假实现）。
   */
  mcpAdapter?: SourceAdapter<McpRegistrySourceConfig>;
  /**
   * MCP 一轮最多采多少个 server。
   *
   * 默认 500 —— 验收标准要求站内至少 300 个 MCP server，
   * 一轮采不满就下一轮接着采（slug 幂等，不会重复）。
   */
  mcpMaxServers?: number;
  /**
   * MCP 一轮最多探测多少个远程 server 的工具定义。
   *
   * 工具探测要跟每个 server 握一次手（慢），所以单独设个闸门。
   */
  mcpMaxToolProbes?: number;
  /**
   * Prompt 语料库的 cron 表达式。
   */
  promptSchedule?: string;
  /**
   * Prompt 语料采集适配器（测试可注入假实现）。
   */
  promptAdapter?: SourceAdapter<PromptRepoSourceConfig>;
  /**
   * 只采集不落库（命令行 `--dry-run` 用）。
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
    createMcpTask({
      schedule:
        options.mcpSchedule ?? resolveSchedule("CRON_MCP_REGISTRY", MCP_REGISTRY_SCHEDULE),
      adapter: options.mcpAdapter,
      maxServers:
        options.mcpMaxServers ?? resolveNumber("MCP_MAX_SERVERS", 500),
      maxToolProbes:
        options.mcpMaxToolProbes ?? resolveNumber("MCP_MAX_TOOL_PROBES", 500),
      dryRun: options.dryRun ?? false,
    }),
    createPromptTask({
      schedule:
        options.promptSchedule ?? resolveSchedule("CRON_PROMPT_REPO", PROMPT_REPO_SCHEDULE),
      adapter: options.promptAdapter,
      dryRun: options.dryRun ?? false,
    }),
    createScenarioTask({
      schedule:
        options.scenarioSchedule ?? resolveSchedule("CRON_SCENARIOS", SCENARIO_SCHEDULE),
    }),
    createVersionSyncTask({
      schedule:
        options.versionSyncSchedule ?? resolveSchedule("CRON_VERSION_SYNC", VERSION_SYNC_SCHEDULE),
      source: options.versionSource,
      limit: options.versionSyncMaxAssets ?? resolveNumber("VERSION_SYNC_MAX_ASSETS", 50),
    }),
  ];
}

/**
 * 上游版本同步任务（票 #16）。
 *
 * ## 为什么是定时任务，不只是命令行
 *
 * 票 #16 的验收标准是「上游仓库有新 commit 时，变更日志被生成并入库」。
 * 「有新 commit 时」= **自动**发生，所以它必须是一条定时任务；
 * 命令行 `pnpm sync:versions` 只是同一条路径的手动入口与兜底。
 * 没有这条 cron 的话，站上的 `AssetVersion` 永远是空的，
 * 收藏后的「上游有新版本」提示也就永远不会出现。
 *
 * ## 一轮只扫 limit 个
 *
 * GitHub 的 commit 列表接口**未认证只有 60 次/小时**（实测见
 * .com-ai-context/verified-endpoints.md），一个资产至少一次调用。
 * 所以一轮默认只扫 50 个，剩下留给下一轮 ——
 * 扫描顺序按「最久没同步的优先」（见 `syncUpstreamVersions`），
 * 所以一轮一轮能轮完所有资产，不会永远只扫同一批。
 *
 * 请求**带缓存**（与其它采集任务同一套）：同一个仓库的 commit 列表
 * 在缓存有效期内只打一次 GitHub。
 */
function createVersionSyncTask(options: {
  schedule: string;
  source?: UpstreamVersionSource;
  limit: number;
}): CollectionTaskDefinition {
  return {
    id: "version-sync:upstream",
    sourceType: "version-sync",
    schedule: options.schedule,
    task: async (): Promise<CollectionTaskResult> => {
      const source =
        options.source ??
        new GitHubVersionSource({
          http: createCachingHttpClient({
            base: createHttpClient(),
            dir: process.env.COLLECTOR_CACHE_DIR ?? DEFAULT_CACHE_DIR,
            ttlMs: Number(process.env.COLLECTOR_CACHE_TTL_MS ?? DEFAULT_CACHE_TTL_MS),
          }),
        });

      const report = await syncUpstreamVersions({ source, limit: options.limit });

      return {
        fetched: report.scanned,
        // 「记上版本」和「发现有新版本并回写」都算写库。
        written: report.updated + report.recorded,
        failed: report.failures.length,
        failures: report.failures.length,
        error:
          report.failures.length > 0
            ? report.failures.map((failure) => `${failure.slug}：${failure.error}`).join("；")
            : undefined,
      };
    },
  };
}

/**
 * Prompt 语料库的采集任务（票 #15）。
 *
 * 与 MCP 那条一样是「一轮采全再入库」，但**每个语料源单独算一次**：
 * 语料源之间互不相关（一个源的 LICENSE 变了不影响其它源），
 * 所以一个源失败只记那一个源的失败。
 */
function createPromptTask(options: {
  schedule: string;
  adapter?: SourceAdapter<PromptRepoSourceConfig>;
  dryRun: boolean;
}): CollectionTaskDefinition {
  return {
    id: "prompt-repo:catalog",
    sourceType: "prompt-repo",
    schedule: options.schedule,
    task: async (): Promise<CollectionTaskResult> => {
      const adapter = options.adapter ?? new PromptRepoAdapter();
      const requests: SourceRequest[] = PROMPT_SOURCES.map((source) => ({
        adapter,
        config: { type: "prompt-repo", source: source.id } as PromptRepoSourceConfig,
        label: source.id,
      }));

      const report = await collectFromSources(requests);
      const fetched = report.items.length;

      const ingested = options.dryRun
        ? { written: 0, failed: 0 }
        : await ingestItems(report.items);

      const failures = report.outcomes
        .filter((outcome) => !outcome.ok)
        .map((outcome) => `${outcome.source}：${outcome.error ?? "未知原因"}`);

      return {
        fetched,
        written: ingested.written,
        failed: ingested.failed,
        failures: failures.length,
        error: failures.length > 0 ? failures.join("；") : undefined,
      };
    },
  };
}

/**
 * 场景卡片派生任务（票 #12）。
 *
 * ## 为什么是独立的一条 cron，而不是采集入库时顺手派生
 *
 * 场景卡片是**派生资产**：入库一个 Skill 会多出一张场景卡片。
 * 把派生塞进采集的入库路径，那条路径的语义就变了
 * （「采到几条就入库几条」变成「采到几条就多出几张卡片」）。
 * 派生单独一条 cron，采集路径保持原来的语义。
 *
 * ## 只处理增量
 *
 * 窗口 = 上一轮派生的**开始**时刻到本轮开始 —— 两轮之间没有缝隙，
 * 上一轮跑到一半时变动的资产这一轮还会再看一遍。
 * 第一次跑没有上一轮，就全量扫一遍（把存量资产补齐）。
 *
 * 全量重算用 `pnpm scenarios:derive`（同一条路径）。
 */
function createScenarioTask(options: { schedule: string }): CollectionTaskDefinition {
  return {
    id: SCENARIO_TASK_SOURCE,
    sourceType: "scenario",
    schedule: options.schedule,
    task: async (): Promise<CollectionTaskResult> => {
      const since = await findLastScenarioRunStartedAt();
      const report = await regenerateScenarioCards(since ? { since } : {});
      // 源资产被删（保留策略物理删除）后留下的孤儿卡片，顺手清掉。
      await pruneOrphanScenarioCards();

      return {
        fetched: report.scanned,
        written: report.cards,
        failed: report.failed,
        failures: 0,
      };
    },
  };
}

/**
 * MCP 官方 registry 的采集任务（票 #13）。
 *
 * 与技能侧的区别：registry 本身就是**权威来源**（免鉴权、字段最规整），
 * 不需要「目录 → 回源」两段式；一轮直接把条目采全再入库。
 *
 * 工具探测（对每个远程 server 握一次 MCP 握手）是最慢的一步，
 * 所以单独用 `mcpMaxToolProbes` 设闸门：超出的留到下一轮。
 */
function createMcpTask(options: {
  schedule: string;
  adapter?: SourceAdapter<McpRegistrySourceConfig>;
  maxServers?: number;
  maxToolProbes?: number;
  dryRun: boolean;
}): CollectionTaskDefinition {
  return {
    id: "mcp-registry:official",
    sourceType: "mcp-registry",
    schedule: options.schedule,
    task: async (): Promise<CollectionTaskResult> => {
      const adapter = options.adapter ?? new McpRegistryAdapter();
      const result = await adapter.fetch({
        type: "mcp-registry",
        limit: 100,
        ...(options.maxServers === undefined ? {} : { maxServers: options.maxServers }),
        ...(options.maxToolProbes === undefined
          ? {}
          : { maxToolProbes: options.maxToolProbes }),
      });

      const ingested = options.dryRun
        ? { written: 0, failed: 0 }
        : await ingestItems(result.items);

      return {
        fetched: result.items.length,
        written: ingested.written,
        failed: ingested.failed,
        failures: ingested.failed,
        error:
          result.error ?? (ingested.failed > 0 ? `${ingested.failed} 条入库失败` : undefined),
      };
    },
  };
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
