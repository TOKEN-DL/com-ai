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
 *
 * ⚠️ 计数（`Asset.favoriteCount` / `Asset.likeCount`）**不由本模块维护**：
 *    它由数据库触发器按互动行数维护（见
 *    prisma/migrations/20261106104000_guest_interaction_guardrails/migration.sql）。
 *    这样计数恒等于「该资产下的互动行数」，绕过服务层直接写库也不会漂移，
 *    合并游客互动到账号时也不用手工修计数（不新增不删除行 → 计数不变）。
 *    本模块只保证「互动行本身」写对。
 */
import { Prisma, type Asset, type Favorite, type Like } from "@prisma/client";

import { guestRateLimit, hashDeviceId } from "@/lib/guest-identity";
import { prisma } from "@/lib/prisma";

/**
 * 互动主体：登录用户，或游客态的设备指纹。
 * 两个都为空说明调用方没弄清当前是谁 —— 直接报错，不静默写匿名行。
 */
export type InteractionActor = {
  userId?: string | null;
  /// 游客态的**哈希后**设备指纹（明文设备指纹不落库）。
  deviceId?: string | null;
  /// 游客态的**哈希后** IP（明文 IP 不落库）。登录态为 null。
  ipHash?: string | null;
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

/** 限流触发时抛出。路由把它翻译成 429 + **用户可见**的提示文案。 */
export class InteractionRateLimitError extends Error {
  /** 建议等待的秒数（当前限流窗口的长度）。 */
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("操作太频繁，请稍后再试。");
    this.name = "InteractionRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
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

    await assertWithinGuestRateLimit(tx, "favorite", assetId, actor);

    // skipDuplicates 让插入本身幂等：并发下第二个请求不会插出第二行，
    // 计数也就不会多算（计数由触发器按行数维护）。
    await tx.favorite.createMany({
      data: [
        {
          assetId,
          actorKey,
          userId: actor.userId ?? null,
          // 登录态的收藏归属账号；设备指纹只留给游客态的行。
          deviceId: actor.userId ? null : (actor.deviceId ?? null),
          ipHash: actor.userId ? null : (actor.ipHash ?? null),
        },
      ],
      skipDuplicates: true,
    });

    return tx.favorite.findUniqueOrThrow({ where: { assetId_actorKey: { assetId, actorKey } } });
  });
}

/** 取消收藏。返回是否真的取消掉了（本来就没收藏则返回 false）。 */
export async function unfavoriteAsset(assetId: string, actor: InteractionActor): Promise<boolean> {
  const actorKey = actorKeyFor(actor);

  const deleted = await prisma.favorite.deleteMany({ where: { assetId, actorKey } });
  return deleted.count > 0;
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

    await assertWithinGuestRateLimit(tx, "like", assetId, actor);

    await tx.like.createMany({
      data: [
        {
          assetId,
          actorKey,
          userId: actor.userId ?? null,
          deviceId: actor.userId ? null : (actor.deviceId ?? null),
          ipHash: actor.userId ? null : (actor.ipHash ?? null),
        },
      ],
      skipDuplicates: true,
    });

    return tx.like.findUniqueOrThrow({ where: { assetId_actorKey: { assetId, actorKey } } });
  });
}

/** 取消点赞。返回是否真的取消掉了。 */
export async function unlikeAsset(assetId: string, actor: InteractionActor): Promise<boolean> {
  const actorKey = actorKeyFor(actor);

  const deleted = await prisma.like.deleteMany({ where: { assetId, actorKey } });
  return deleted.count > 0;
}

/** 某资产的收藏数与点赞数。 */
export async function interactionCounts(
  assetId: string,
): Promise<{ favoriteCount: number; likeCount: number }> {
  const asset = await prisma.asset.findUniqueOrThrow({
    where: { id: assetId },
    select: { favoriteCount: true, likeCount: true },
  });
  return { favoriteCount: asset.favoriteCount, likeCount: asset.likeCount };
}

/** 当前主体对某资产的互动状态（页面刷新后按钮状态靠它恢复）。 */
export async function actorInteractionState(
  assetId: string,
  actor: InteractionActor,
): Promise<{ liked: boolean; favorited: boolean }> {
  const actorKey = actorKeyFor(actor);

  const [like, favorite] = await Promise.all([
    prisma.like.findUnique({
      where: { assetId_actorKey: { assetId, actorKey } },
      select: { id: true },
    }),
    prisma.favorite.findUnique({
      where: { assetId_actorKey: { assetId, actorKey } },
      select: { id: true },
    }),
  ]);

  return { liked: like !== null, favorited: favorite !== null };
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

/**
 * 游客态限流：同一 IP 在时间窗内对**同一资产**的互动条数有上限。
 *
 * 计数直接数「该 IP 在窗口内为该资产新建的互动行」——不需要额外的限流表，
 * 互动行本身就是限流账本。
 *
 * 先锁住资产行再判定：并发请求排队过闸，上限不会被同时越过。
 */
async function assertWithinGuestRateLimit(
  tx: Prisma.TransactionClient,
  kind: "like" | "favorite",
  assetId: string,
  actor: InteractionActor,
): Promise<void> {
  // 登录态是已验证账号，不受游客限流约束。
  if (actor.userId) {
    return;
  }

  const ipHash = actor.ipHash;
  if (!ipHash) {
    // 拿不到 IP（直连应用、没有边缘代理）时退化成设备指纹的唯一约束：
    // 同一台设备仍然只能对同一资产留下一次互动。
    return;
  }

  const { max, windowSeconds } = guestRateLimit();

  await tx.$queryRaw`SELECT "id" FROM "Asset" WHERE "id" = ${assetId} FOR UPDATE`;

  const since = new Date(Date.now() - windowSeconds * 1000);
  const used =
    kind === "like"
      ? await tx.like.count({ where: { assetId, ipHash, createdAt: { gte: since } } })
      : await tx.favorite.count({ where: { assetId, ipHash, createdAt: { gte: since } } });

  if (used >= max) {
    throw new InteractionRateLimitError(windowSeconds);
  }
}

/**
 * 把游客态的互动合并到账号名下（登录后调用）。
 *
 * 语义：
 *   - 游客收藏 / 点赞过的资产 → 归属改到账号（行还在，计数不变）；
 *   - 账号本来就收藏 / 点赞过的同一资产 → **去重**，丢掉游客那一条
 *     （计数随之回落一条，不会翻倍）。
 *
 * 幂等：重复执行不会让计数翻倍（游客行已经不在设备名下了）。
 */
export type GuestInteractionMergeResult = {
  /** 迁到账号名下的收藏条数。 */
  favorites: number;
  /** 账号已收藏同一资产而被去重丢弃的游客收藏条数。 */
  favoritesDeduplicated: number;
  /** 迁到账号名下的点赞条数。 */
  likes: number;
  /** 账号已点赞同一资产而被去重丢弃的游客点赞条数。 */
  likesDeduplicated: number;
};

/**
 * 合并游客态互动到账号。
 *
 * @param input.userId  目标账号 id。
 * @param input.deviceId 游客态的**设备指纹原文**（浏览器 localStorage 里那串随机 id）。
 *                      函数内部会哈希成落库用的值 —— 调用方不需要自己处理密钥。
 */
export async function mergeGuestInteractionsToUser(input: {
  userId: string;
  deviceId: string;
}): Promise<GuestInteractionMergeResult> {
  const guestKey = `device:${hashDeviceId(input.deviceId)}`;
  const userKey = `user:${input.userId}`;

  return prisma.$transaction(async (tx) => {
    const favorites = await mergeActorRows(tx, "Favorite", guestKey, userKey, input.userId);
    const likes = await mergeActorRows(tx, "Like", guestKey, userKey, input.userId);

    return {
      favorites: favorites.moved,
      favoritesDeduplicated: favorites.deduplicated,
      likes: likes.moved,
      likesDeduplicated: likes.deduplicated,
    };
  });
}

/**
 * 合并一张互动表。
 *
 * 先删掉与账号重复的游客行（触发器把计数减回去），再把剩下的游客行改挂到账号名下
 * （改挂不新增不删除行 → 计数不变，天然不翻倍）。
 */
async function mergeActorRows(
  tx: Prisma.TransactionClient,
  table: "Favorite" | "Like",
  guestKey: string,
  userKey: string,
  userId: string,
): Promise<{ moved: number; deduplicated: number }> {
  const target = Prisma.raw(`"${table}"`);

  const deduplicated = await tx.$executeRaw`
    DELETE FROM ${target} AS guest
    USING ${target} AS owner
    WHERE guest."actorKey" = ${guestKey}
      AND owner."actorKey" = ${userKey}
      AND owner."assetId" = guest."assetId"
  `;

  const moved = await tx.$executeRaw`
    UPDATE ${target} AS guest
    SET "actorKey" = ${userKey}, "userId" = ${userId}, "deviceId" = NULL, "ipHash" = NULL
    WHERE guest."actorKey" = ${guestKey}
      AND NOT EXISTS (
        SELECT 1 FROM ${target} AS owner
        WHERE owner."assetId" = guest."assetId" AND owner."actorKey" = ${userKey}
      )
  `;

  return { moved, deduplicated };
}
