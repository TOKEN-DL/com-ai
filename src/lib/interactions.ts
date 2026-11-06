/**
 * 收藏 / 点赞的共享路径。
 *
 * 三类资产（SKILL / MCP / PROMPT）走的是**同一个函数、同两张表** ——
 * 收藏与点赞挂在 Asset 上，不按 kind 分表（spec 决策 3 的理由：
 * 跨类型搜索、推荐、收藏、点赞只需查询主表）。
 *
 * 游客态：按设备指纹（deviceId）识别主体，登录后由账号接管（userId）。
 * 主体键 actorKey = `user:<userId>` 或 `device:<deviceId>`，
 * 与 assetId 组成唯一键，因此同一个人重复收藏不会产生第二条记录。
 */
import type { Asset, Favorite, Like } from "@prisma/client";

import { prisma } from "@/lib/prisma";

/**
 * 互动主体：登录用户，或游客态的设备指纹。
 * 两个都为空说明调用方没弄清当前是谁 —— 直接报错，不静默写匿名行。
 */
export type InteractionActor = {
  userId?: string | null;
  deviceId?: string | null;
};

/** 主体键：登录态优先用账号，否则用设备指纹。 */
export function actorKeyFor(actor: InteractionActor): string {
  if (actor.userId) {
    return `user:${actor.userId}`;
  }
  if (actor.deviceId) {
    return `device:${actor.deviceId}`;
  }
  throw new Error("互动主体缺失：需要 userId（登录态）或 deviceId（游客态）");
}

/** 收藏一个资产。幂等：重复收藏不会重复计数。 */
export async function favoriteAsset(assetId: string, actor: InteractionActor): Promise<Favorite> {
  const actorKey = actorKeyFor(actor);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.favorite.findUnique({
      where: { assetId_actorKey: { assetId, actorKey } },
    });
    if (existing) {
      return existing;
    }

    const favorite = await tx.favorite.create({
      data: {
        assetId,
        actorKey,
        userId: actor.userId ?? null,
        // 登录态的收藏归属账号；设备指纹只留给游客态的行。
        deviceId: actor.userId ? null : (actor.deviceId ?? null),
      },
    });

    await tx.$executeRaw`
      UPDATE "Asset" SET "favoriteCount" = "favoriteCount" + 1, "updatedAt" = NOW()
      WHERE "id" = ${assetId}
    `;

    return favorite;
  });
}

/** 取消收藏。返回是否真的取消掉了（本来就没收藏则返回 false）。 */
export async function unfavoriteAsset(assetId: string, actor: InteractionActor): Promise<boolean> {
  const actorKey = actorKeyFor(actor);

  return prisma.$transaction(async (tx) => {
    const deleted = await tx.favorite.deleteMany({ where: { assetId, actorKey } });
    if (deleted.count === 0) {
      return false;
    }

    await tx.$executeRaw`
      UPDATE "Asset" SET "favoriteCount" = GREATEST("favoriteCount" - 1, 0), "updatedAt" = NOW()
      WHERE "id" = ${assetId}
    `;

    return true;
  });
}

/** 给一个资产点赞。幂等。 */
export async function likeAsset(assetId: string, actor: InteractionActor): Promise<Like> {
  const actorKey = actorKeyFor(actor);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.like.findUnique({
      where: { assetId_actorKey: { assetId, actorKey } },
    });
    if (existing) {
      return existing;
    }

    const like = await tx.like.create({
      data: {
        assetId,
        actorKey,
        userId: actor.userId ?? null,
        deviceId: actor.userId ? null : (actor.deviceId ?? null),
      },
    });

    await tx.$executeRaw`
      UPDATE "Asset" SET "likeCount" = "likeCount" + 1, "updatedAt" = NOW()
      WHERE "id" = ${assetId}
    `;

    return like;
  });
}

/** 取消点赞。返回是否真的取消掉了。 */
export async function unlikeAsset(assetId: string, actor: InteractionActor): Promise<boolean> {
  const actorKey = actorKeyFor(actor);

  return prisma.$transaction(async (tx) => {
    const deleted = await tx.like.deleteMany({ where: { assetId, actorKey } });
    if (deleted.count === 0) {
      return false;
    }

    await tx.$executeRaw`
      UPDATE "Asset" SET "likeCount" = GREATEST("likeCount" - 1, 0), "updatedAt" = NOW()
      WHERE "id" = ${assetId}
    `;

    return true;
  });
}

/** 某主体收藏的资产（跨 kind，同一条查询路径）。 */
export async function listFavoritedAssets(actor: InteractionActor): Promise<Asset[]> {
  return listAssetsForActor("favorite", actor);
}

/** 某主体点赞的资产（跨 kind，同一条查询路径）。 */
export async function listLikedAssets(actor: InteractionActor): Promise<Asset[]> {
  return listAssetsForActor("like", actor);
}

async function listAssetsForActor(
  table: "favorite" | "like",
  actor: InteractionActor,
): Promise<Asset[]> {
  const actorKey = actorKeyFor(actor);

  const rows =
    table === "favorite"
      ? await prisma.favorite.findMany({
          where: { actorKey },
          orderBy: { createdAt: "desc" },
          select: { assetId: true },
        })
      : await prisma.like.findMany({
          where: { actorKey },
          orderBy: { createdAt: "desc" },
          select: { assetId: true },
        });

  if (rows.length === 0) {
    return [];
  }

  const assets = await prisma.asset.findMany({
    where: { id: { in: rows.map((row) => row.assetId) } },
  });
  const byId = new Map(assets.map((asset) => [asset.id, asset]));

  // 保持互动的时间顺序。
  return rows
    .map((row) => byId.get(row.assetId))
    .filter((asset): asset is Asset => asset !== undefined);
}
