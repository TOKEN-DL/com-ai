/**
 * 热度指标同步（票 #24）。
 *
 * ## 它解决什么
 *
 * 榜单源（skills.sh 首页）给的是**累计安装量**与**近 8 周周安装量** ——
 * 三个热度视图（all-time / trending / hot）的原始输入都在这儿。
 *
 * 采集入库那条路（{@link ingestItems}）会把它们算成 `heatScore` / `trendScore`，
 * 但那条路要**回源 GitHub** 拿每个仓库的 SKILL.md —— 未认证只有 60 次/小时
 * （实测），一轮跑不完是常态；而且它会顺带重写简介（内容），
 * 只想刷新数字的时候不该惊动内容。
 *
 * 所以这里只做一件事：**按 slug 把榜单上的数字补到已收录的资产上**。
 * 只碰 `installs` / `heatScore` / `trendScore` 三个数字字段，
 * 简介、正文、「何时用 / 怎么用」一个字都不动。
 *
 * ## 场景卡片跟着源资产走
 *
 * 卡片是源 Skill 的**派生产物**（票 #12），它的热度数字本来就抄自源资产。
 * 源资产的数字变了而卡片不变，`/scenarios` 的「近期增速」排序就会是一排 0 ——
 * 所以同步完源资产，也要把卡片那三个数字一并刷新。
 *
 * ## 与采集入库的关系
 *
 * 两者不冲突，也不互相替代：
 *   - 采集入库负责「把新技能收进来」（内容 + 数字一起更新）；
 *   - 本模块负责「把已收录技能的热度数字刷新到最新」（只动数字）。
 *
 * 日常调度仍以采集 cron 为主。本模块是轻量补充：榜单上的安装量每天都在变，
 * 而回源 GitHub 才是慢的那一步 —— 数字不该被它拖着一起等。
 */
import type { PrismaClient } from "@prisma/client";

import { computeHeatScore, weeklyTrend } from "@/collector/heat";
import type { RawItem } from "@/collector/types";
import { prisma } from "@/lib/prisma";

/** 一轮同步的结果。 */
export type HeatSyncReport = {
  /// 榜单里 Skill 条目的条数。
  scanned: number;
  /// 在站内匹配到资产的条数。
  matched: number;
  /// 数字确实变了的条数。
  updated: number;
  /// 榜单里有、站内还没收录的条数。
  missing: number;
  /// 单条更新失败的条数。
  failed: number;
  /// 跟着源资产一起刷新的场景卡片条数。
  cardsUpdated: number;
};

/** 站内资产里与热度同步有关的字段。 */
type AssetMetrics = {
  id: string;
  slug: string;
  stars: number;
  installs: number;
  heatScore: number;
  trendScore: number;
};

/** 一份要写回去的热度数字。 */
type HeatNumbers = {
  installs: number;
  heatScore: number;
  trendScore: number;
};

/**
 * 把榜单上的热度数字同步到已收录的资产上。
 *
 * @param items 榜单条目（{@link RawItem}）。只有 `kind = SKILL` 的会被处理。
 * @param deps 依赖注入（测试用）。
 */
export async function syncHeatMetrics(
  items: readonly RawItem[],
  deps: { db?: PrismaClient } = {},
): Promise<HeatSyncReport> {
  const db = deps.db ?? prisma;

  const skills = items.filter((item) => item.metadata.kind === "SKILL");
  if (skills.length === 0) {
    return {
      scanned: 0,
      matched: 0,
      updated: 0,
      missing: 0,
      failed: 0,
      cardsUpdated: 0,
    };
  }

  // 一次查完，别一个 slug 一次查询。
  const assets = await db.asset.findMany({
    where: { slug: { in: skills.map((item) => item.slug) } },
    select: {
      id: true,
      slug: true,
      stars: true,
      installs: true,
      heatScore: true,
      trendScore: true,
    },
  });
  const bySlug = new Map<string, AssetMetrics>(
    assets.map((asset) => [asset.slug, asset as AssetMetrics]),
  );

  // 先算好每个源资产的新数字：卡片要抄的是同一份数字，不能各算各的。
  const numbers = new Map<string, HeatNumbers>();
  for (const item of skills) {
    const asset = bySlug.get(item.slug);
    if (!asset) {
      // 榜单里有、站内还没收录 —— 那是采集入库那条路的事，本模块不管。
      continue;
    }
    const installs = nonNegativeInt(item.metadata.installs);
    const weeklyInstalls = item.metadata.weeklyInstalls ?? [];
    numbers.set(item.slug, {
      installs,
      trendScore: weeklyTrend(weeklyInstalls),
      // 热度分用**站内记着的 star 数**算：榜单没有 star，而采集时拿到的
      // star 数是准的，不该为了刷数字把它抹成 0。
      heatScore: computeHeatScore({ installs, stars: asset.stars, weeklyInstalls }),
    });
  }

  let updated = 0;
  let failed = 0;
  const changed: { id: string; slug: string; numbers: HeatNumbers }[] = [];

  for (const [slug, value] of numbers) {
    const asset = bySlug.get(slug);
    if (!asset) {
      continue;
    }
    if (
      asset.installs === value.installs &&
      asset.heatScore === value.heatScore &&
      asset.trendScore === value.trendScore
    ) {
      // 数字没变就不写库 —— 不制造无谓的 updatedAt 抖动。
      continue;
    }
    try {
      await db.asset.update({ where: { id: asset.id }, data: value });
      updated += 1;
      changed.push({ id: asset.id, slug, numbers: value });
    } catch {
      failed += 1;
    }
  }

  const cardsUpdated = await syncDerivedCards(db, changed);

  return {
    scanned: skills.length,
    matched: numbers.size,
    updated,
    missing: skills.length - numbers.size,
    failed,
    cardsUpdated,
  };
}

/**
 * 把场景卡片的热度数字刷成源资产的那一份。
 *
 * 卡片是派生产物（票 #12）：源资产改了，卡片不改，两个列表页的
 * 「近期增速」排序就会对不上。
 */
async function syncDerivedCards(
  db: PrismaClient,
  changed: { id: string; slug: string; numbers: HeatNumbers }[],
): Promise<number> {
  if (changed.length === 0) {
    return 0;
  }

  const cards = await db.scenarioDetail.findMany({
    where: { sourceAssetId: { in: changed.map((item) => item.id) } },
    select: { assetId: true, sourceAssetId: true },
  });
  if (cards.length === 0) {
    return 0;
  }

  const bySourceId = new Map(changed.map((item) => [item.id, item.numbers]));
  const cardAssets = await db.asset.findMany({
    where: { id: { in: cards.map((card) => card.assetId) } },
    select: { id: true, installs: true, heatScore: true, trendScore: true },
  });
  const cardById = new Map(cardAssets.map((asset) => [asset.id, asset]));

  let cardsUpdated = 0;
  for (const card of cards) {
    const numbers = bySourceId.get(card.sourceAssetId);
    const asset = cardById.get(card.assetId);
    if (!numbers || !asset) {
      continue;
    }
    if (
      asset.installs === numbers.installs &&
      asset.heatScore === numbers.heatScore &&
      asset.trendScore === numbers.trendScore
    ) {
      continue;
    }
    try {
      await db.asset.update({ where: { id: asset.id }, data: numbers });
      cardsUpdated += 1;
    } catch {
      // 单张卡片更新失败不该让整轮同步失败 —— 它只是派生数据。
    }
  }
  return cardsUpdated;
}

/** 安装量：负数与非法值按 0 处理（榜单偶尔给奇怪的值）。 */
function nonNegativeInt(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.trunc(value);
}
