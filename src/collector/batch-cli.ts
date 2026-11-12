/**
 * 批量采集命令行入口（票 #6）。
 *
 * 用法（见 scripts/collect-batch.mjs）：
 *
 *     pnpm collect:batch                      # 跑榜单源（默认）
 *     pnpm collect:batch --source sitemap    # 跑站点地图源
 *     pnpm collect:batch --source all        # 两个都跑
 *     pnpm collect:batch --source mcp        # 跑 MCP 官方 registry
 *     pnpm collect:batch --max-repos 50      # 限制本轮回源多少个仓库
 *     pnpm collect:batch --max-servers 300   # 限制本轮采多少个 MCP server
 *     pnpm collect:batch --dry-run           # 只采集不入库
 *
 * 走的是**和 cron 完全一样**的任务定义（{@link buildCollectionTasks}），
 * 所以手动跑出来的结果与自动跑的一致：运行记录、告警、保留策略都照常生效。
 *
 * 环境变量：
 *   - `DATABASE_URL` —— 必填（`--dry-run` 除外）；
 *   - `GITHUB_TOKEN` —— 可选。有 token 走 5000 次/小时，没有则走 60 次/小时。
 */
import { runCollectionTask } from "@/collector/collection-run";
import { buildCollectionTasks } from "@/collector/collection-tasks";
import { prisma } from "@/lib/prisma";

type Options = {
  source: "leaderboard" | "sitemap" | "all" | "retention" | "mcp";
  maxRepos?: number;
  /// MCP 一轮最多采多少个 server。
  maxServers?: number;
  /// MCP 一轮最多探测多少个远程 server 的工具定义。
  maxToolProbes?: number;
  dryRun: boolean;
};

function parseArgs(argv: string[]): Options {
  const options: Options = { source: "leaderboard", dryRun: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--source") {
      const value = argv[i + 1];
      i += 1;
      if (
        value === "leaderboard" ||
        value === "sitemap" ||
        value === "all" ||
        value === "retention" ||
        value === "mcp"
      ) {
        options.source = value;
      } else {
        throw new Error(
          `--source 只能是 leaderboard / sitemap / all / retention / mcp，收到：${value}`,
        );
      }
      continue;
    }
    if (arg === "--max-repos") {
      const value = Number(argv[i + 1]);
      i += 1;
      if (Number.isFinite(value) && value > 0) {
        options.maxRepos = Math.floor(value);
      }
      continue;
    }
    if (arg === "--max-servers") {
      const value = Number(argv[i + 1]);
      i += 1;
      if (Number.isFinite(value) && value > 0) {
        options.maxServers = Math.floor(value);
      }
      continue;
    }
    if (arg === "--max-tool-probes") {
      const value = Number(argv[i + 1]);
      i += 1;
      if (Number.isFinite(value) && value >= 0) {
        options.maxToolProbes = Math.floor(value);
      }
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (!options.dryRun && !process.env.DATABASE_URL) {
    console.error("缺少 DATABASE_URL，无法入库（只想看采集结果就加 --dry-run）。");
    process.exitCode = 2;
    return;
  }

  const tasks = buildCollectionTasks({
    dryRun: options.dryRun,
    ...(options.maxRepos === undefined
      ? {}
      : { leaderboardMaxRepos: options.maxRepos, sitemapMaxRepos: options.maxRepos }),
    ...(options.maxServers === undefined ? {} : { mcpMaxServers: options.maxServers }),
    ...(options.maxToolProbes === undefined ? {} : { mcpMaxToolProbes: options.maxToolProbes }),
  });

  const selected = tasks.filter((task) => {
    if (options.source === "all") return task.sourceType === "skills-sh";
    if (options.source === "retention") return task.id === "retention";
    if (options.source === "mcp") return task.sourceType === "mcp-registry";
    return task.id.endsWith(options.source);
  });

  console.log(
    `开始批量采集：${selected.map((task) => task.id).join("、")}${options.dryRun ? "（dry-run，不入库）" : ""}`,
  );

  let failures = 0;

  for (const task of selected) {
    const outcome = await runCollectionTask({
      source: task.id,
      sourceType: task.sourceType,
      task: task.task,
    });

    console.log(
      `  ${outcome.status === "OK" ? "✅" : outcome.status === "PARTIAL" ? "⚠️" : "❌"} ${outcome.source}：${outcome.status}，采到 ${outcome.fetched} 条，入库 ${outcome.written} 条，失败 ${outcome.failed} 条，用时 ${outcome.durationMs}ms`,
    );
    if (outcome.error) {
      console.error(`     ${outcome.error}`);
    }
    if (outcome.status === "FAILED") {
      failures += 1;
    }
  }

  await prisma.$disconnect();

  if (failures > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
