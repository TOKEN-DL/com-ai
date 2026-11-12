/**
 * 批量重跑中文简介的命令行入口（票 #7）。
 *
 * 用法（见 scripts/regenerate-summaries.mjs）：
 *
 *     pnpm summaries:regenerate                      # 重跑全部
 *     pnpm summaries:regenerate --limit 100          # 最多重跑 100 条
 *     pnpm summaries:regenerate --slug foo-bar       # 只重跑某一条
 *     pnpm summaries:regenerate --version v2         # 用指定的生成器版本重跑
 *     pnpm summaries:regenerate --force              # 忽略缓存，强制重新调模型
 *     pnpm summaries:regenerate --dry-run            # 只统计，不写库
 *
 * ## 什么时候需要它
 *
 * **模型或提示词变更后**。做法是：把 `SUMMARY_GENERATOR_VERSION`（见
 * src/lib/summary-service.ts）改成新的一版 → 部署 → 跑一次这个命令。
 * 新版本的缓存键对不上，所以每一条都会重新生成。
 *
 * ## 一条硬规矩
 *
 * **人工覆盖过的简介永远跳过**（`summaryOverriddenAt` 非空）。
 * 这里**故意不提供**「连人工覆盖的一起重跑」的开关 ——
 * 人工纠正过的东西不该被机器改回去。
 */
import { parseCliArgs } from "@/collector/cli-args";
import { prisma } from "@/lib/prisma";
import { regenerateSummaries, SUMMARY_GENERATOR_VERSION } from "@/lib/summary-service";

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));

  if (!options.dryRun && !process.env.DATABASE_URL) {
    console.error("缺少 DATABASE_URL，无法入库（只想看统计就加 --dry-run）。");
    process.exitCode = 2;
    return;
  }

  const version = options.version ?? SUMMARY_GENERATOR_VERSION;

  console.log(
    `开始重跑中文简介：生成器版本 ${version}` +
      `${options.slugs.length > 0 ? `，只跑 ${options.slugs.join("、")}` : ""}` +
      `${options.force ? "，忽略缓存" : ""}` +
      `${options.dryRun ? "（dry-run，不写库）" : ""}`,
  );

  if (options.dryRun) {
    const count = await prisma.asset.count({
      where: {
        contentTier: "FULL",
        ...(options.slugs.length > 0 ? { slug: { in: options.slugs } } : {}),
      },
    });
    console.log(`  FULL 档资产共 ${count} 条（dry-run，未生成）。`);
    await prisma.$disconnect();
    return;
  }

  const report = await regenerateSummaries({
    generatorVersion: version,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.slugs.length > 0 ? { slugs: options.slugs } : {}),
    ...(options.force ? { ignoreCache: true } : {}),
  });

  console.log(
    `  扫到 ${report.scanned} 条：重新生成 ${report.regenerated} 条，` +
      `命中缓存 ${report.cached} 条，跳过人工覆盖 ${report.skippedOverridden} 条，` +
      `无正文跳过 ${report.skippedNoContent} 条，失败 ${report.failed} 条。`,
  );

  await prisma.$disconnect();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
