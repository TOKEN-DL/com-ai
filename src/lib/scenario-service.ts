/**
 * 场景卡片的派生与落库（票 #12）。
 *
 * ## 落库还是实时派生
 *
 * **落库。** 验收标准要求场景卡片「能被统一搜索命中」「下方可评论」：
 * - 搜索走的是 Postgres 全文索引（`Asset_fulltext_idx`，票 #5）——
 *   实时派生出来的东西进不了索引，也就搜不到；
 * - 评论挂在 `Comment.assetId` 上，需要一个真实的资产行。
 *
 * 所以每张场景卡片是**一条 `kind = SCENARIO` 的 Asset 行**，
 * 与源资产的对应关系记在 `ScenarioDetail` 表里。
 *
 * ## 去重
 *
 * 两道闸：
 *   1. 派生层：`deriveScenarios` 按归一化键（NFKC + 小写 + 去空白 + 去标点）去重；
 *   2. 数据库层：`ScenarioDetail(sourceAssetId, scenarioKey)` 上的唯一约束。
 *
 * ## 派生什么时候跑
 *
 * 两条路径，共用同一个函数：
 *   - **定时任务**（`scenarios`，票 #12）：每天跑一次，只处理上一轮之后
 *     被改动过的资产（增量）—— 采集跑完之后，新资产自然就带上卡片了；
 *   - **批量命令**（`pnpm scenarios:derive`）：全量重算 / 手动兜底。
 *
 * 派生是**幂等**的：同一个源资产 + 同一个场景，重跑多少次都只有一张卡片
 * （slug 由 (源资产 slug, 场景键) 决定，`writeAsset` 按 slug upsert）。
 *
 * ## 许可证分层
 *
 * **只从 FULL 档资产派生。** 场景短语是从资产原文（「何时用」/ frontmatter 自述）
 * 里抽出来的，属于「基于原文的内容」；METADATA_ONLY 档位的资产没有原文可依据
 * （数据库触发器会把它们的「何时用 / 怎么用」清空），派生出来的卡片也就没有依据。
 * 源资产的档位掉出 FULL 时，它派生出来的卡片会被**删除**（不是留着降级）。
 */
import { createHash } from "node:crypto";

import type { AssetKind, SummarySource } from "@prisma/client";

import { writeAsset } from "@/lib/asset-writer";
import { prisma } from "@/lib/prisma";
import {
  deriveScenarios,
  readFrontmatterDescription,
  type DerivedScenario,
  type ScenarioOrigin,
} from "@/lib/scenario-derivation";

/**
 * 场景卡片在 `Asset.sourceId` 上的标记。
 *
 * 采集来的资产 sourceId 是采集源标识（"skills-sh:leaderboard" 之类），
 * 派生来的卡片统一标成这个值 —— 一眼能看出「这一行不是采来的，是派生的」。
 */
export const SCENARIO_SOURCE_ID = "scenario";

/**
 * 派生任务在运行记录（`CollectionRun`）里的源标识。
 *
 * 定时任务用它找「上一轮什么时候跑的」，好做增量窗口。
 */
export const SCENARIO_TASK_SOURCE = "scenarios";

/** 场景描述的最大长度（卡片摘要用）。 */
const MAX_SUMMARY_LENGTH = 200;

/** 派生不出来场景时的原因。 */
export type ScenarioSkipReason = "not_found" | "not_full_tier" | "no_scenario";

/** 单个资产的派生结果。 */
export type ScenarioDeriveOutcome = {
  /// 源资产 slug。
  sourceSlug: string;
  /// 派生出的场景数。
  derived: number;
  /// 写下的卡片 slug。
  cardSlugs: string[];
  /// 删掉的过期卡片数（场景变了 / 源资产不再是 FULL 档）。
  removed: number;
  /// 派生不出来时的原因。
  reason?: ScenarioSkipReason;
};

/** 批量派生的统计。 */
export type RegenerateScenariosReport = {
  /// 扫到的资产数。
  scanned: number;
  /// 派生到场景的资产数。
  withScenarios: number;
  /// 写下的卡片数。
  cards: number;
  /// 删掉的过期卡片数。
  removed: number;
  /// 没有可派生场景而跳过的资产数。
  skippedNoScenario: number;
  /// 不是 FULL 档而跳过的资产数。
  skippedNotFullTier: number;
  /// 单个资产失败（不影响其它资产）的次数。
  failed: number;
};

/**
 * 场景卡片的 slug。
 *
 * = `sc-{场景短语的可读形式}-{哈希}`。
 *
 * - 可读部分只保留 ASCII 字母数字（中文场景短语会退化成 "card"）；
 * - 哈希取 (源资产 slug, 场景键) 的 SHA-256 前 16 位 —— 保证
 *   「同一资产 + 同一场景」永远是同一个 slug，`writeAsset` 按 slug upsert，
 *   所以重复派生不会多出第二张卡片。
 */
export function buildScenarioSlug(sourceSlug: string, scenarioKey: string, text: string): string {
  const hash = createHash("sha256")
    .update(`${sourceSlug}\u0000${scenarioKey}`, "utf8")
    .digest("hex")
    .slice(0, 16);

  const readable = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 32)
    .replace(/-+$/u, "");

  return `sc-${readable.length > 0 ? readable : "card"}-${hash}`;
}

/** 截断到指定长度（超出加省略号）。 */
function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max).trimEnd()}…`;
}

/** 源资产里能用来派生场景的两段文字。 */
type SourceText = {
  /// 票 #7 的「何时用」（权威）。
  whenToUse: string | null;
  /// frontmatter 的自述（兜底）。
  description: string | null;
};

/**
 * 卡片的「场景描述」：按来源取原文，截断到卡片摘要的长度。
 */
function buildCardSummary(source: SourceText, scenario: DerivedScenario): string | null {
  const text = scenario.origin === "whenToUse" ? source.whenToUse : source.description;
  if (!text) {
    return null;
  }
  const trimmed = text.trim();
  return trimmed.length > 0 ? truncate(trimmed, MAX_SUMMARY_LENGTH) : null;
}

/**
 * 卡片简介的来源标记 —— **必须如实反映这段文字是谁写的**。
 *
 * spec 约束 2 是个硬要求：**LLM 生成的简介必须标注「AI 生成，版权归原作者」**。
 * 把模型写的文字标成别的，等于没标 —— 那就是违规，不只是不好看。
 *
 * - `whenToUse`（「何时用」）：这段文字是票 #7 生成的，
 *   源资产是什么标记，卡片就是什么标记：
 *   模型写的 → `LLM`；模型挂了走模板降级 → `TEMPLATE`；运营人工改过 → `HUMAN`。
 * - `frontmatter`（上游作者自述）：是**人写的**（上游仓库的作者自己写的），
 *   既不是模型也不是模板 → `HUMAN`。
 *
 * ⚠️ 这里的默认值是 `TEMPLATE` 而不是 `LLM`：源资产没有标记说明它没走过
 *    摘要流程（「何时用」多半是空的），这时候保守地按「非模型内容」处理，
 *    宁可少标也不误标 —— 误标成 AI 会让用户以为作者授权我们改写。
 */
function buildCardSummarySource(
  origin: ScenarioOrigin,
  sourceSummarySource: SummarySource | null,
): SummarySource {
  if (origin === "frontmatter") {
    return "HUMAN";
  }
  return sourceSummarySource ?? "TEMPLATE";
}

/**
 * 删掉某个源资产派生出来的、已经不该存在的卡片。
 *
 * 「不该存在」有两种：
 *   - 场景变了（源资产的「何时用」被重写了）→ 旧场景的卡片作废；
 *   - 源资产不再是 FULL 档 → 它的卡片整体作废。
 */
async function removeStaleCards(sourceAssetId: string, keepSlugs: string[]): Promise<number> {
  const stale = await prisma.scenarioDetail.findMany({
    where: {
      sourceAssetId,
      ...(keepSlugs.length > 0 ? { asset: { slug: { notIn: keepSlugs } } } : {}),
    },
    select: { assetId: true },
  });

  if (stale.length === 0) {
    return 0;
  }

  // 先删扩展行（外键会级联），再删卡片资产行。
  await prisma.scenarioDetail.deleteMany({
    where: { assetId: { in: stale.map((row) => row.assetId) } },
  });
  await prisma.asset.deleteMany({
    where: { id: { in: stale.map((row) => row.assetId) } },
  });

  return stale.length;
}

/**
 * 从一个资产派生它的场景卡片并写库。
 *
 * 幂等：同一个资产重复调用，结果一样（卡片按 slug upsert，
 * 数据库上还有 (源资产, 场景键) 的唯一约束兜底）。
 */
export async function deriveScenarioCards(sourceAssetId: string): Promise<ScenarioDeriveOutcome> {
  const source = await prisma.asset.findUnique({
    where: { id: sourceAssetId },
    include: { skillDetail: true },
  });

  if (!source) {
    return { sourceSlug: "", derived: 0, cardSlugs: [], removed: 0, reason: "not_found" };
  }

  const sourceText: SourceText = {
    whenToUse: source.whenToUse,
    description: readFrontmatterDescription(source.skillDetail?.frontmatter),
  };

  // 许可证分层：只有 FULL 档能派生场景（见文件头的说明）。
  if (source.contentTier !== "FULL") {
    const removed = await removeStaleCards(source.id, []);
    return {
      sourceSlug: source.slug,
      derived: 0,
      cardSlugs: [],
      removed,
      reason: "not_full_tier",
    };
  }

  const scenarios = deriveScenarios({
    whenToUse: sourceText.whenToUse,
    frontmatter: source.skillDetail?.frontmatter,
  });

  if (scenarios.length === 0) {
    const removed = await removeStaleCards(source.id, []);
    return {
      sourceSlug: source.slug,
      derived: 0,
      cardSlugs: [],
      removed,
      reason: "no_scenario",
    };
  }

  const cardSlugs: string[] = [];

  for (const scenario of scenarios) {
    const slug = buildScenarioSlug(source.slug, scenario.key, scenario.text);

    await writeAsset({
      kind: "SCENARIO",
      slug,
      displayName: scenario.text,
      // 卡片的档位跟着源资产走：源资产允许再分发，卡片里的场景短语才允许再分发。
      license: source.license,
      contentBody: null,
      summaryZh: buildCardSummary(sourceText, scenario),
      // 来源标记如实反映「这段文字是谁写的」—— 模型写的必须标 LLM（见 buildCardSummarySource）。
      summarySource: buildCardSummarySource(scenario.origin, source.summarySource),
      whenToUse: null,
      howToUse: null,
      repoOwner: source.repoOwner,
      repoName: source.repoName,
      repoUrl: source.repoUrl,
      upstreamUrl: source.upstreamUrl,
      sourceId: SCENARIO_SOURCE_ID,
      publishedAt: source.publishedAt,
      lastSyncedAt: new Date(),
      isOfficial: source.isOfficial,
      stars: source.stars,
      installs: source.installs,
      heatScore: source.heatScore,
      detail: {
        scenario: {
          sourceAssetId: source.id,
          sourceAssetSlug: source.slug,
          scenarioText: scenario.text,
          scenarioKey: scenario.key,
          origin: scenario.origin,
        },
      },
    });

    cardSlugs.push(slug);
  }

  // 场景变了 → 旧卡片作废。
  const removed = await removeStaleCards(source.id, cardSlugs);

  return { sourceSlug: source.slug, derived: scenarios.length, cardSlugs, removed };
}

/** 批量派生的入参。 */
export type RegenerateScenariosOptions = {
  /// 最多处理多少个资产。默认 5000。
  limit?: number;
  /// 只处理这些 slug；不传 = 全部。
  slugs?: string[];
  /// 只处理「这段时间里被改动过」的资产（增量）。
  ///
  /// 定时任务用这个口径：只补上一轮采集之后变过的资产，
  /// 不重扫全库（重扫会把所有卡片的更新时间都刷新一遍，
  /// 列表页的「最近更新」排序就没意义了）。
  since?: Date;
};

/**
 * 上一轮场景派生任务的开始时刻。
 *
 * 定时任务用它当增量窗口的起点：窗口从**上一轮开始**算（不是结束），
 * 这样两轮之间没有缝隙 —— 上一轮跑到一半时变动的资产，这一轮还会再看一遍。
 *
 * 没有上一轮（第一次跑）就返回 undefined = 全量扫一遍。
 */
export async function findLastScenarioRunStartedAt(): Promise<Date | undefined> {
  const last = await prisma.collectionRun.findFirst({
    where: { source: SCENARIO_TASK_SOURCE, status: { in: ["OK", "PARTIAL"] } },
    orderBy: { startedAt: "desc" },
    select: { startedAt: true },
  });

  return last?.startedAt;
}

/**
 * 批量派生场景卡片（可重跑）。
 *
 * 用法：模型/规则改了、或者站上新增了一批资产之后，跑一次这个命令。
 * 因为派生是幂等的，重跑不会产生重复卡片。
 */
export async function regenerateScenarioCards(
  options: RegenerateScenariosOptions = {},
): Promise<RegenerateScenariosReport> {
  const limit = options.limit ?? 5000;

  const assets = await prisma.asset.findMany({
    where: {
      kind: "SKILL",
      ...(options.since ? { updatedAt: { gte: options.since } } : {}),
      ...(options.slugs && options.slugs.length > 0 ? { slug: { in: options.slugs } } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: limit,
    select: { id: true, contentTier: true },
  });

  const report: RegenerateScenariosReport = {
    scanned: assets.length,
    withScenarios: 0,
    cards: 0,
    removed: 0,
    skippedNoScenario: 0,
    skippedNotFullTier: 0,
    failed: 0,
  };

  for (const asset of assets) {
    try {
      const outcome = await deriveScenarioCards(asset.id);

      if (outcome.reason === "not_full_tier") {
        report.skippedNotFullTier += 1;
        continue;
      }
      if (outcome.reason === "no_scenario") {
        report.skippedNoScenario += 1;
        continue;
      }
      if (outcome.reason === "not_found") {
        continue;
      }

      report.withScenarios += 1;
      report.cards += outcome.derived;
      report.removed += outcome.removed;
    } catch {
      // 单个资产失败不影响其它资产 —— 与采集侧同一条原则。
      report.failed += 1;
    }
  }

  return report;
}

/**
 * 场景卡片 → 源资产。
 *
 * 评论要挂在**源资产**上（票 #12：卡片评论区与资产详情页共用同一套评论数据），
 * 所以拿到卡片之后还要再问一句「它对应哪个 Skill」。
 */
export async function resolveScenarioSource(
  cardAssetId: string,
): Promise<{ id: string; slug: string } | null> {
  const detail = await prisma.scenarioDetail.findUnique({
    where: { assetId: cardAssetId },
    select: { sourceAsset: { select: { id: true, slug: true } } },
  });

  return detail ? detail.sourceAsset : null;
}

/**
 * 批量取卡片对应的源资产（列表页用：一页几十张卡片，一次查完）。
 *
 * ⚠️ 这**不是检索** —— 检索一律经由 `getSearchService`（票 #5 的硬规矩）。
 *    这里只是把当前页已经查出来的卡片补上「它指向哪个 Skill」，
 *    好让列表页能直接给出「直达 Skill」的链接。
 */
export type ScenarioSourceRef = {
  assetId: string;
  slug: string;
  displayName: string;
  /// 源资产的类型（详情页链接按它分派）。
  kind: AssetKind;
  repoOwner: string | null;
  repoName: string | null;
};

/** 卡片 id → 源资产。查不到的卡片不会出现在结果里。 */
export async function listScenarioSources(
  cardIds: string[],
): Promise<Map<string, ScenarioSourceRef>> {
  if (cardIds.length === 0) {
    return new Map();
  }

  const rows = await prisma.scenarioDetail.findMany({
    where: { assetId: { in: cardIds } },
    select: {
      assetId: true,
      sourceAsset: {
        select: {
          id: true,
          slug: true,
          displayName: true,
          kind: true,
          repoOwner: true,
          repoName: true,
        },
      },
    },
  });

  return new Map(
    rows.map((row) => [
      row.assetId,
      {
        assetId: row.sourceAsset.id,
        slug: row.sourceAsset.slug,
        displayName: row.sourceAsset.displayName,
        kind: row.sourceAsset.kind,
        repoOwner: row.sourceAsset.repoOwner,
        repoName: row.sourceAsset.repoName,
      },
    ]),
  );
}

/**
 * 清理孤儿卡片。
 *
 * 源资产被删（保留策略物理删除）时，数据库外键会把它派生出来的
 * `ScenarioDetail` 行一起删掉，但卡片那条 `Asset` 行还在 ——
 * 那就是一张指向空源的孤儿卡片，这里清掉。
 */
export async function pruneOrphanScenarioCards(): Promise<number> {
  const orphans = await prisma.asset.findMany({
    where: { kind: "SCENARIO", scenarioDetail: null },
    select: { id: true },
  });

  if (orphans.length === 0) {
    return 0;
  }

  await prisma.asset.deleteMany({ where: { id: { in: orphans.map((row) => row.id) } } });
  return orphans.length;
}
