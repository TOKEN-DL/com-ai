/**
 * 批量派生场景卡片的命令行入口（票 #12）。
 *
 * 用法（见 scripts/derive-scenarios.mjs）：
 *
 *     pnpm scenarios:derive                # 全量派生（默认上限 5000 个资产）
 *     pnpm scenarios:derive --limit 100    # 最多处理 100 个资产
 *     pnpm scenarios:derive --slug foo-bar # 只处理某一条
 *     pnpm scenarios:derive --dry-run      # 只统计，不写库
 *     pnpm scenarios:derive --prune        # 顺便清理孤儿卡片
 *
 * ## 什么时候需要它
 *
 * - **站上新增了一批资产**（采集跑完之后）：入库时已经顺手派生过一次，
 *   这个命令是兜底 —— 采集那一轮没派生成功的条目在这里补上。
 * - **派生规则改了**：规则一改，卡片内容就会变，跑一次这个命令全部重算。
 *   派生是幂等的，重跑不会产生重复卡片。
 */
import { prisma } from "@/lib/prisma";
import { pruneOrphanScenarioCards, regenerateScenarioCards } from "@/lib/scenario-service";

type Options = {
  limit?: number;
  slugs: string[];
  dryRun: boolean;
  prune: boolean;
};

function parseArgs(argv: string[]): Options {
  const options: Options = { slugs: [], dryRun: false, prune: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--limit") {
      const value = Number(process.argv[i + 1]);
      i += 1;
      if (Number.isFinite(value) && value > 0) {
        options.limit = Math.floor(value);
      }
      continue;
    }
    if (arg === "--slug") {
      const value = process.argv[i + 1];
      i += 1;
      if (typeof value === "string" && value.trim().length > 0) {
        options.slugs.push(value.trim());
      }
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--prune") {
      options.prune = true;
      continue;
    }
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (!options.dryRun && !process.env.DATABASE_URL) {
    console.error("缺少 DATABASE_URL，无法入库（只想看统计就加 --dry-run）。");
    process.exitCode = 2;
    return;
  }

  console.log(
    `开始派生场景卡片` +
      `${options.slugs.length > 0 ? `，只跑 ${options.slugs.join("、")}` : ""}` +
      `${options.dryRun ? "（dry-run，不写库）" : ""}`,
  );

  if (options.dryRun) {
    const [total, full] = await Promise.all([
      prisma.asset.count({ where: { kind: "SKILL" } }),
      prisma.asset.count({ where: { kind: "SKILL", contentTier: "FULL" } }),
    ]);
    console.log(`  Skill 共 ${total} 条，其中 FULL 档 ${full} 条（只有 FULL 档能派生场景）。`);
    console.log("  dry-run 未写库。");
    await prisma.$disconnect();
    return;
  }

  const report = await regenerateScenarioCards({
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.slugs.length > 0 ? { slugs: options.slugs } : {}),
  });

  console.log(
    `  扫到 ${report.scanned} 个资产：派生到场景 ${report.withScenarios} 个，` +
      `写卡片 ${report.cards} 张，删过期卡片 ${report.removed} 张，` +
      `无场景跳过 ${report.skippedNoScenario} 个，非 FULL 档跳过 ${report.skippedNotFullTier} 个，` +
      `失败 ${report.failed} 个。`,
  );

  if (options.prune) {
    const pruned = await pruneOrphanScenarioCards();
    console.log(`  清理孤儿卡片 ${pruned} 张。`);
  }

  await prisma.$disconnect();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
