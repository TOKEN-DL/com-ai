/**
 * 游客态互动合并到账号（票 #8 验收标准第 5 条）。
 *
 * 合并的输入是「游客态的设备指纹原文 + 目标 userId」，输出是合并后的条数。
 * 本票不实现登录（那是 #9），所以这里直接建 User 行、直接调合并函数。
 *
 * 关键性质：
 *   - 合并后计数**不翻倍**（游客那一条和账号那一条只能算一条）；
 *   - 合并**幂等**：重复执行不会让计数继续涨。
 */
import { describe, expect, it } from "vitest";

import { POST as favoriteRoute } from "@/app/api/assets/[slug]/favorite/route";
import {
  DELETE as unlikeRoute,
  POST as likeRoute,
} from "@/app/api/assets/[slug]/like/route";
import {
  listFavoritedAssets,
  listLikedAssets,
  mergeGuestInteractionsToUser,
} from "@/lib/interactions";
import { prisma } from "@/lib/prisma";

const DEVICE = "guest-device-merge-01";

async function seedSkill(slug: string): Promise<string> {
  const asset = await prisma.asset.create({
    data: { kind: "SKILL", slug, displayName: `Skill ${slug}`, license: "MIT" },
  });
  return asset.id;
}

async function seedUser(email: string): Promise<string> {
  const user = await prisma.user.create({ data: { email, emailVerifiedAt: new Date() } });
  return user.id;
}

function call(path: string, method = "POST"): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "x-device-id": DEVICE },
  });
}

function params(slug: string) {
  return { params: Promise.resolve({ slug }) };
}

describe("游客态互动合并到账号", () => {
  it("游客的收藏与点赞迁到账号名下，计数不翻倍", async () => {
    const skillA = "merge-skill-a";
    const skillB = "merge-skill-b";
    const assetA = await seedSkill(skillA);
    const assetB = await seedSkill(skillB);
    const userId = await seedUser("merge-owner@example.com");

    // 游客态先互动（走真实的 HTTP 路径）。
    await favoriteRoute(call(`/api/assets/${skillA}/favorite`), params(skillA));
    await favoriteRoute(call(`/api/assets/${skillB}/favorite`), params(skillB));
    await likeRoute(call(`/api/assets/${skillA}/like`), params(skillA));

    const before = await prisma.asset.findUniqueOrThrow({ where: { id: assetA } });
    expect(before.favoriteCount).toBe(1);
    expect(before.likeCount).toBe(1);

    const result = await mergeGuestInteractionsToUser({ userId, deviceId: DEVICE });

    expect(result.favorites).toBe(2);
    expect(result.likes).toBe(1);
    expect(result.favoritesDeduplicated).toBe(0);
    expect(result.likesDeduplicated).toBe(0);

    // 计数不翻倍：一条互动还是一条。
    const after = await prisma.asset.findUniqueOrThrow({ where: { id: assetA } });
    expect(after.favoriteCount).toBe(1);
    expect(after.likeCount).toBe(1);

    const afterB = await prisma.asset.findUniqueOrThrow({ where: { id: assetB } });
    expect(afterB.favoriteCount).toBe(1);

    // 归属换成了账号，设备名下的行不再存在。
    const favorites = await listFavoritedAssets({ userId });
    expect(favorites.map((asset) => asset.slug).sort()).toEqual([skillA, skillB]);
    const likes = await listLikedAssets({ userId });
    expect(likes.map((asset) => asset.slug)).toEqual([skillA]);

    expect(await prisma.favorite.count({ where: { deviceId: { not: null } } })).toBe(0);
    expect(await prisma.like.count({ where: { deviceId: { not: null } } })).toBe(0);
  });

  it("账号已经收藏过同一个资产时合并会去重，计数不翻倍", async () => {
    const slug = "merge-dedup-skill";
    const assetId = await seedSkill(slug);
    const userId = await seedUser("merge-dedup@example.com");

    await favoriteRoute(call(`/api/assets/${slug}/favorite`), params(slug));
    // 账号在合并之前就已经收藏过同一个资产。
    await prisma.favorite.create({
      data: { assetId, actorKey: `user:${userId}`, userId },
    });

    const before = await prisma.asset.findUniqueOrThrow({ where: { id: assetId } });
    expect(before.favoriteCount).toBe(2);

    const result = await mergeGuestInteractionsToUser({ userId, deviceId: DEVICE });

    expect(result.favorites).toBe(0);
    expect(result.favoritesDeduplicated).toBe(1);

    const after = await prisma.asset.findUniqueOrThrow({ where: { id: assetId } });
    expect(after.favoriteCount).toBe(1);
    expect(await prisma.favorite.count({ where: { assetId } })).toBe(1);

    const favorites = await listFavoritedAssets({ userId });
    expect(favorites.map((asset) => asset.slug)).toEqual([slug]);
  });

  it("合并是幂等的：重复执行不会让计数翻倍", async () => {
    const slug = "merge-idempotent-skill";
    const assetId = await seedSkill(slug);
    const userId = await seedUser("merge-idempotent@example.com");

    await favoriteRoute(call(`/api/assets/${slug}/favorite`), params(slug));
    await likeRoute(call(`/api/assets/${slug}/like`), params(slug));

    const first = await mergeGuestInteractionsToUser({ userId, deviceId: DEVICE });
    expect(first.favorites).toBe(1);
    expect(first.likes).toBe(1);

    const second = await mergeGuestInteractionsToUser({ userId, deviceId: DEVICE });
    expect(second.favorites).toBe(0);
    expect(second.likes).toBe(0);

    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: assetId } });
    expect(asset.favoriteCount).toBe(1);
    expect(asset.likeCount).toBe(1);
  });

  it("游客取消互动后合并不会把已取消的互动带进账号", async () => {
    const slug = "merge-after-unlike-skill";
    const assetId = await seedSkill(slug);
    const userId = await seedUser("merge-after-unlike@example.com");

    await likeRoute(call(`/api/assets/${slug}/like`), params(slug));
    await unlikeRoute(call(`/api/assets/${slug}/like`, "DELETE"), params(slug));

    const result = await mergeGuestInteractionsToUser({ userId, deviceId: DEVICE });

    expect(result.likes).toBe(0);

    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: assetId } });
    expect(asset.likeCount).toBe(0);
  });
});
