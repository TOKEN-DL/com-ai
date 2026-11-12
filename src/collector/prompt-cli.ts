/**
 * Prompt 语料采集命令行入口（票 #15）。
 *
 * 用法（见 scripts/collect-prompts.mjs）：
 *
 *     pnpm collect:prompts                     # 采全部语料源
 *     pnpm collect:prompts f/prompts.chat      # 只采指定的源
 *
 * 环境变量：
 *   - `DATABASE_URL` —— 必填，Prisma 连接串；
 *   - `GITHUB_TOKEN` —— 可选。有 token 走 5000 次/小时，没有则走 60 次/小时。
 *
 * ⚠️ 单个源失败不会中断其它源：失败的源会在最后汇总里列出来
 *    （与「单源异常不阻塞其它源」同一条原则）。
 */
import { ingestItems } from "@/collector/ingest";
import { PromptRepoAdapter } from "@/collector/prompt-repo";
import { PROMPT_SOURCES } from "@/collector/prompt-sources";
import { collectFromSources, type SourceRequest } from "@/collector/pipeline";
import type { PromptRepoSourceConfig } from "@/collector/types";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (!process.env.DATABASE_URL) {
    console.error("缺少 DATABASE_URL，无法入库。");
    process.exitCode = 2;
    return;
  }

  // 不给参数 = 采全部源。给了参数就只采那几个（不认识的源直接报错，别静默跳过）。
  const selected = args.length > 0 ? args : PROMPT_SOURCES.map((source) => source.id);
  const unknown = selected.filter(
    (id) => !PROMPT_SOURCES.some((source) => source.id === id),
  );
  if (unknown.length > 0) {
    console.error(
      `未知的语料源：${unknown.join(", ")}\n已知：${PROMPT_SOURCES.map((s) => s.id).join(", ")}`,
    );
    process.exitCode = 2;
    return;
  }

  const adapter = new PromptRepoAdapter();
  const requests: SourceRequest[] = selected.map((source) => ({
    adapter,
    config: { type: "prompt-repo", source } as PromptRepoSourceConfig,
    label: source,
  }));

  console.log(`开始采集 ${selected.length} 个 Prompt 语料源…`);
  const report = await collectFromSources(requests);

  for (const outcome of report.outcomes) {
    if (outcome.ok) {
      console.log(
        `  ✅ ${outcome.source}：采到 ${outcome.items.length} 条${outcome.warning ? `（注意：${outcome.warning}）` : ""}`,
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

  if (ingested.failed > 0 || report.failures > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
