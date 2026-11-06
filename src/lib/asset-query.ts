/**
 * 资产的共享查询路径。
 *
 * 三类资产共用一套查询入口：列表、详情都只认 Asset 主表，
 * 类型差异字段由 kind 决定读哪张扩展表（spec 决策 3）。
 *
 * ⚠️ 这里只做「按主表字段取数」这一层；关键词检索（全文 + trigram + 标签矩阵）
 *    是 #5 的 SearchService 的事，不要在这里另写一套。
 */
import type { Asset, AssetKind, McpDetail, Prisma, PromptDetail, SkillDetail } from "@prisma/client";

import { prisma } from "@/lib/prisma";

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
    where: kind ? { kind } : undefined,
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
};

/** 按 slug 取详情，并按 kind 带上对应的扩展表。 */
export async function getAssetBySlug(slug: string): Promise<AssetWithDetail | null> {
  const asset = await prisma.asset.findUnique({ where: { slug } });
  return asset ? withDetail(asset) : null;
}

/** 按 id 取详情，并按 kind 带上对应的扩展表。 */
export async function getAssetById(id: string): Promise<AssetWithDetail | null> {
  const asset = await prisma.asset.findUnique({ where: { id } });
  return asset ? withDetail(asset) : null;
}

/** 按 kind 读对应的那张 1:1 扩展表，另外两张保持 null。 */
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

  return { ...asset, skillDetail, mcpDetail, promptDetail };
}
