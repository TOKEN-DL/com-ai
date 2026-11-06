/**
 * 采集命令行入口：把一个或多个 GitHub 仓库采下来并入库。
 *
 * 用法（见 scripts/collect-skills.mjs）：
 *
 *     pnpm collect:skills vercel-labs/skills obra/superpowers
 *     pnpm collect:skills vercel-labs/skills@main
 *
 * 环境变量：
 *   - `DATABASE_URL` —— 必填，Prisma 连接串；
 *   - `GITHUB_TOKEN` —— 可选。有 token 走 5000 次/小时，没有则走 60 次/小时。
 *
 * ⚠️ 单个源失败不会中断其它源：失败的源会在最后汇总里列出来。
 */
import { ingestItems } from "@/collector/ingest";
import { GitHubRepoAdapter } from "@/collector/github";
import { collectFromSources, type SourceRequest } from "@/collector/pipeline";
import type { GitHubRepoSourceConfig } from "@/collector/types";

type ParsedSource = GitHubRepoSourceConfig & { label: string };

function parseSource(raw: string): ParsedSource {
  const [repoPart, branch] = raw.split("@");
  const [owner, repo] = repoPart.split("/");
  if (!owner || !repo) {
    throw new Error(`仓库写法应为 owner/repo[@branch]，收到：${raw}`);
  }
  return {
    type: "github-repo",
    owner,
    repo,
    branch,
    label: repoPart,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("用法：pnpm collect:skills <owner/repo[@branch]> [...]");
    process.exitCode = 2;
    return;
  }

  if (!process.env.DATABASE_URL) {
    console.error("缺少 DATABASE_URL，无法入库。");
    process.exitCode = 2;
    return;
  }

  const sources = args.map(parseSource);
  const adapter = new GitHubRepoAdapter();

  const requests: SourceRequest[] = sources.map((source) => ({
    adapter,
    config: source,
    label: source.label,
  }));

  console.log(`开始采集 ${sources.length} 个源…`);
  const report = await collectFromSources(requests);

  for (const outcome of report.outcomes) {
    if (outcome.ok) {
      console.log(
        `  ✅ ${outcome.source}：采到 ${outcome.items.length} 个条目${outcome.warning ? `（注意：${outcome.warning}）` : ""}`,
      );
    } else {
      console.error(`  ❌ ${outcome.source}：失败 —— ${outcome.error}`);
    }
  }

  const ingested = await ingestItems(report.items);
  console.log(`入库完成：成功 ${ingested.written} 条，失败 ${ingested.failed} 条。`);

  for (const outcome of ingested.outcomes.filter((entry) => !entry.ok)) {
    console.error(`  ❌ ${outcome.slug}：${outcome.error}`);
  }

  if (ingested.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
