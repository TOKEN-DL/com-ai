/**
 * 资产的共享查询路径。
 *
 * 三类资产共用一套查询入口：列表、详情都只认 Asset 主表，
 * 类型差异字段由 kind 决定读哪张扩展表（spec 决策 3）。
 *
 * ⚠️ 这里只做「按主表字段取数」这一层；关键词检索（全文 + trigram + 标签矩阵）
 *    是 #5 的 SearchService 的事，不要在这里另写一套。
 */
import type {
  Asset,
  AssetKind,
  McpDetail,
  Prisma,
  PromptDetail,
  ScenarioDetail,
  SkillDetail,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";

/**
 * 「对外可见」的过滤条件（票 #11）。
 *
 * 用户发布的资产被下架（审核中 PENDING / 已拒绝 REJECTED）时**不对外可见** ——
 * 列表与详情都过滤掉，跟归档（archivedAt）一个口径。
 *
 * `every` 的语义：没有发布记录的资产（采集来的）条件天然成立 —— 采集来的条目
 * 不走发布审核，不该被这条过滤误伤。
 */
export const VISIBLE_PUBLICATION_FILTER = {
  publishedBy: { every: { status: "PUBLISHED" as const } },
} satisfies Prisma.AssetWhereInput;

export type AssetListOptions = {
  /// 不传 = 跨三种 kind；传了 = 只看这一类。
  kind?: AssetKind;
  limit?: number;
  offset?: number;
  /// 默认按热度（heatScore）倒序。
  orderBy?: "heat" | "recent" | "installs";
};

/** 列表查询：同一个函数覆盖三种 kind。 */
export async function listAssets(options: AssetListOptions = {}): Promise<Asset[]> {
  const { kind, limit = 50, offset = 0, orderBy = "heat" } = options;

  const orderByClause: Prisma.AssetOrderByWithRelationInput =
    orderBy === "recent"
      ? { createdAt: "desc" }
      : orderBy === "installs"
        ? { installs: "desc" }
        : { heatScore: "desc" };

  return prisma.asset.findMany({
    // 已归档的条目**前端不可见**（spec 决策 4 的三档保留策略）：
    // 超期但高热度的资产保留在库里，只是不再展示。
    // 被下架的用户发布（审核中 / 已拒绝）同样不可见（票 #11）。
    where: { archivedAt: null, ...VISIBLE_PUBLICATION_FILTER, ...(kind ? { kind } : {}) },
    orderBy: orderByClause,
    take: limit,
    skip: offset,
  });
}

/** 带类型扩展表的资产详情。 */
export type AssetWithDetail = Asset & {
  skillDetail: SkillDetail | null;
  mcpDetail: McpDetail | null;
  promptDetail: PromptDetail | null;
  /** 场景卡片的扩展行（票 #12）。SCENARIO 之外恒为 null。 */
  scenarioDetail: ScenarioDetail | null;
};

/** 按 slug 取详情，并按 kind 带上对应的扩展表。 */
export async function getAssetBySlug(slug: string): Promise<AssetWithDetail | null> {
  const asset = await prisma.asset.findFirst({
    where: { slug, archivedAt: null, ...VISIBLE_PUBLICATION_FILTER },
  });
  return asset ? withDetail(asset) : null;
}

/** 按 id 取详情，并按 kind 带上对应的扩展表。 */
export async function getAssetById(id: string): Promise<AssetWithDetail | null> {
  const asset = await prisma.asset.findFirst({
    where: { id, archivedAt: null },
  });
  return asset ? withDetail(asset) : null;
}

/** 按 kind 读对应的那张 1:1 扩展表，另外几张保持 null。 */
async function withDetail(asset: Asset): Promise<AssetWithDetail> {
  const skillDetail =
    asset.kind === "SKILL"
      ? await prisma.skillDetail.findUnique({ where: { assetId: asset.id } })
      : null;
  const mcpDetail =
    asset.kind === "MCP"
      ? await prisma.mcpDetail.findUnique({ where: { assetId: asset.id } })
      : null;
  const promptDetail =
    asset.kind === "PROMPT"
      ? await prisma.promptDetail.findUnique({ where: { assetId: asset.id } })
      : null;
  const scenarioDetail =
    asset.kind === "SCENARIO"
      ? await prisma.scenarioDetail.findUnique({ where: { assetId: asset.id } })
      : null;

  return { ...asset, skillDetail, mcpDetail, promptDetail, scenarioDetail };
}
