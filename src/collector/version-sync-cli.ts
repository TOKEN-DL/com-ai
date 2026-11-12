/**
 * 版本同步命令行入口：检查上游有没有新 commit，有就记版本 + 生成变更日志 + 回写内容。
 *
 * 用法（见 scripts/sync-versions.mjs）：
 *
 *     pnpm sync:versions            # 默认扫 50 个资产
 *     pnpm sync:versions --limit 200
 *
 * 环境变量：
 *   - `DATABASE_URL` —— 必填，Prisma 连接串；
 *   - `GITHUB_TOKEN` —— 可选。有 token 走 5000 次/小时，没有则走 60 次/小时。
 *
 * ## 为什么有 `--limit`
 *
 * 每个资产至少要打一次 GitHub 的 commit 列表接口。未认证只有 **60 次/小时**
 * （实测见 .com-ai-context/verified-endpoints.md），所以一轮默认只扫 50 个，
 * 剩下的留给下一轮 —— 想全量扫就分批跑，或配 `GITHUB_TOKEN`。
 */
import { createCachingHttpClient, DEFAULT_CACHE_DIR, DEFAULT_CACHE_TTL_MS } from "@/collector/cache";
import { GitHubVersionSource } from "@/collector/github-versions";
import { createHttpClient } from "@/collector/http";
import { syncUpstreamVersions } from "@/collector/version-sync";

/** 默认一轮扫多少个资产（未认证 60 次/小时，留出余量）。 */
const DEFAULT_LIMIT = 50;

function readLimit(args: string[]): number {
  const index = args.indexOf("--limit");
  if (index < 0) {
    return DEFAULT_LIMIT;
  }

  const parsed = Number.parseInt(args[index + 1] ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--limit 需要一个正整数，收到：${args[index + 1] ?? ""}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const limit = readLimit(args);

  if (!process.env.DATABASE_URL) {
    console.error("缺少 DATABASE_URL，无法同步版本。");
    process.exitCode = 2;
    return;
  }

  // 请求带缓存：短时间重复跑同一轮不会重复打 GitHub 的 API 配额。
  const source = new GitHubVersionSource({
    http: createCachingHttpClient({
      base: createHttpClient(),
      dir: process.env.COLLECTOR_CACHE_DIR ?? DEFAULT_CACHE_DIR,
      ttlMs: Number(process.env.COLLECTOR_CACHE_TTL_MS ?? DEFAULT_CACHE_TTL_MS),
    }),
  });

  console.log(`开始同步上游版本（最多 ${limit} 个资产）…`);
  const report = await syncUpstreamVersions({ source, limit });

  console.log(
    `同步完成：扫描 ${report.scanned} 个，更新 ${report.updated} 个，首次记录 ${report.recorded} 个，` +
      `无变化 ${report.upToDate} 个，跳过 ${report.skipped} 个，取不到 ${report.unavailable} 个。`,
  );

  for (const failure of report.failures) {
    console.error(`  ❌ ${failure.slug}：${failure.error}`);
  }

  // 有硬失败（上游结构变更之类）时以非零退出码结束，调度器能看出这轮没跑干净。
  if (report.failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
