/**
 * 热度指标同步命令行入口（票 #24）。
 *
 * 用法：
 *
 *     pnpm sync:heat
 *
 * 干的事：从 skills.sh 首页榜单取安装量与近 8 周周安装量，
 * 按 slug 同步到已收录的资产上（只动 installs / heatScore / trendScore）。
 *
 * 与 `pnpm collect:batch` 的分工：那一条负责「把新技能收进来」，
 * 这一条只负责「把已收录技能的热度数字刷新到最新」——
 * 不用回源 GitHub，所以不受那 60 次/小时的影响。
 *
 * 环境变量：
 *   - `DATABASE_URL` —— 必填。
 */
import { syncHeatMetrics } from "@/collector/heat-sync";
import { SkillsShAdapter } from "@/collector/skills-sh";
import { prisma } from "@/lib/prisma";

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("缺少 DATABASE_URL，无法同步。");
    process.exitCode = 2;
    return;
  }

  console.log("读取 skills.sh 榜单…");
  const result = await new SkillsShAdapter().fetch({
    type: "skills-sh",
    catalog: "leaderboard",
  });

  const report = await syncHeatMetrics(result.items);

  console.log(
    `榜单 ${report.scanned} 条，站内匹配 ${report.matched} 条，更新 ${report.updated} 条，` +
      `站内未收录 ${report.missing} 条，失败 ${report.failed} 条。`,
  );

  await prisma.$disconnect();

  if (report.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
