/**
 * 三类资产共用同一套收藏、点赞与查询路径（票 #3 验收标准）。
 *
 * 收藏与点赞挂在 Asset 上，不按 kind 分表：SKILL / MCP / PROMPT 走的是
 * **同一个函数、同一张表**。查询路径同理——列表、详情都不需要按 kind 分叉。
 */
import { describe, expect, it } from "vitest";

import { listAssets, getAssetBySlug } from "@/lib/asset-query";
import {
  favoriteAsset,
  likeAsset,
  listFavoritedAssets,
  listLikedAssets,
  unlikeAsset,
  unfavoriteAsset,
} from "@/lib/interactions";
import { prisma } from "@/lib/prisma";

async function seedOneOfEachKind(): Promise<void> {
  await prisma.asset.create({
    data: { kind: "SKILL", slug: "fav-skill", displayName: "收藏用 Skill", license: "MIT" },
  });
  await prisma.asset.create({
    data: { kind: "MCP", slug: "fav-mcp", displayName: "收藏用 MCP", license: "MIT" },
  });
  await prisma.asset.create({
    data: { kind: "PROMPT", slug: "fav-prompt", displayName: "收藏用 Prompt", license: "MIT" },
  });
}

async function seedUser(email: string): Promise<string> {
  const user = await prisma.user.create({ data: { email, emailVerifiedAt: new Date() } });
  return user.id;
}

describe("收藏路径对三种 kind 一视同仁", () => {
  it("SKILL / MCP / PROMPT 都能用同一个函数收藏，计数各记在 Asset 上", async () => {
    await seedOneOfEachKind();

    for (const slug of ["fav-skill", "fav-mcp", "fav-prompt"]) {
      const asset = await prisma.asset.findUniqueOrThrow({ where: { slug } });
      await favoriteAsset(asset.id, { deviceId: "device-a" });
    }

    const assets = await prisma.asset.findMany({ orderBy: { slug: "asc" } });
    expect(assets.map((asset) => asset.favoriteCount)).toEqual([1, 1, 1]);

    const favorites = await prisma.favorite.count();
    expect(favorites).toBe(3);
  });

  it("点赞同样一套路径，计数落在同一个 Asset 表", async () => {
    await seedOneOfEachKind();

    for (const slug of ["fav-skill", "fav-mcp", "fav-prompt"]) {
      const asset = await prisma.asset.findUniqueOrThrow({ where: { slug } });
      await likeAsset(asset.id, { deviceId: "device-a" });
    }

    const assets = await prisma.asset.findMany({ orderBy: { slug: "asc" } });
    expect(assets.map((asset) => asset.likeCount)).toEqual([1, 1, 1]);
  });

  it("重复收藏同一资产是幂等的，不会重复计数", async () => {
    const asset = await prisma.asset.create({
      data: { kind: "SKILL", slug: "fav-idem", displayName: "幂等收藏", license: "MIT" },
    });

    await favoriteAsset(asset.id, { deviceId: "device-a" });
    await favoriteAsset(asset.id, { deviceId: "device-a" });

    expect(await prisma.favorite.count()).toBe(1);
    const reread = await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(reread.favoriteCount).toBe(1);
  });

  it("取消收藏 / 取消点赞后计数回落", async () => {
    const asset = await prisma.asset.create({
      data: { kind: "MCP", slug: "fav-un", displayName: "取消收藏", license: "MIT" },
    });

    await favoriteAsset(asset.id, { deviceId: "device-a" });
    await likeAsset(asset.id, { deviceId: "device-a" });

    await unfavoriteAsset(asset.id, { deviceId: "device-a" });
    await unlikeAsset(asset.id, { deviceId: "device-a" });

    const reread = await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(reread.favoriteCount).toBe(0);
    expect(reread.likeCount).toBe(0);
    expect(await prisma.favorite.count()).toBe(0);
    expect(await prisma.like.count()).toBe(0);
  });
});

describe("游客态与登录态共用同一条路径", () => {
  it("游客态按设备指纹收藏，登录态按账号收藏，落在同一张表", async () => {
    await seedOneOfEachKind();
    const userId = await seedUser("fan@example.com");
    const asset = await prisma.asset.findUniqueOrThrow({ where: { slug: "fav-skill" } });

    await favoriteAsset(asset.id, { deviceId: "device-guest" });
    await favoriteAsset(asset.id, { userId });

    expect(await prisma.favorite.count({ where: { assetId: asset.id } })).toBe(2);

    const guestRow = await prisma.favorite.findFirstOrThrow({ where: { deviceId: "device-guest" } });
    expect(guestRow.userId).toBeNull();

    const userRow = await prisma.favorite.findFirstOrThrow({ where: { userId } });
    expect(userRow.deviceId).toBeNull();

    const reread = await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(reread.favoriteCount).toBe(2);
  });

  it("登录态列出自己收藏的资产（跨 kind）", async () => {
    await seedOneOfEachKind();
    const userId = await seedUser("owner@example.com");

    const skill = await prisma.asset.findUniqueOrThrow({ where: { slug: "fav-skill" } });
    const prompt = await prisma.asset.findUniqueOrThrow({ where: { slug: "fav-prompt" } });

    await favoriteAsset(skill.id, { userId });
    await favoriteAsset(prompt.id, { userId });

    const favorites = await listFavoritedAssets({ userId });
    expect(favorites.map((asset) => asset.slug).sort()).toEqual(["fav-prompt", "fav-skill"]);
    expect(favorites.map((asset) => asset.kind).sort()).toEqual(["PROMPT", "SKILL"]);
  });

  it("游客态按设备指纹列出收藏的资产", async () => {
    await seedOneOfEachKind();
    const asset = await prisma.asset.findUniqueOrThrow({ where: { slug: "fav-mcp" } });

    await favoriteAsset(asset.id, { deviceId: "device-guest" });
    await likeAsset(asset.id, { deviceId: "device-guest" });

    const favorites = await listFavoritedAssets({ deviceId: "device-guest" });
    expect(favorites.map((asset) => asset.slug)).toEqual(["fav-mcp"]);

    const likes = await listLikedAssets({ deviceId: "device-guest" });
    expect(likes.map((asset) => asset.slug)).toEqual(["fav-mcp"]);
  });
});

describe("查询路径对三种 kind 一视同仁", () => {
  it("不指定 kind 时跨三种 kind 返回同一个列表", async () => {
    await seedOneOfEachKind();

    const all = await listAssets();
    expect(all.map((asset) => asset.slug).sort()).toEqual(["fav-mcp", "fav-prompt", "fav-skill"]);
  });

  it("指定 kind 时按 kind 过滤（同一套函数，靠参数分叉而不是靠分表）", async () => {
    await seedOneOfEachKind();

    const skills = await listAssets({ kind: "SKILL" });
    expect(skills.map((asset) => asset.slug)).toEqual(["fav-skill"]);

    const prompts = await listAssets({ kind: "PROMPT" });
    expect(prompts.map((asset) => asset.slug)).toEqual(["fav-prompt"]);
  });

  it("详情查询按 kind 自动带上对应的扩展表", async () => {
    await prisma.asset.create({
      data: {
        kind: "SKILL",
        slug: "detail-skill",
        displayName: "详情 Skill",
        license: "MIT",
        skillDetail: { create: { skillPath: "SKILL.md", hosts: ["claude-code"] } },
      },
    });
    await prisma.asset.create({
      data: {
        kind: "PROMPT",
        slug: "detail-prompt",
        displayName: "详情 Prompt",
        license: "MIT",
        promptDetail: { create: { modality: "TEXT", act: "写文案" } },
      },
    });

    const skill = await getAssetBySlug("detail-skill");
    expect(skill?.kind).toBe("SKILL");
    expect(skill?.skillDetail?.skillPath).toBe("SKILL.md");

    const prompt = await getAssetBySlug("detail-prompt");
    expect(prompt?.kind).toBe("PROMPT");
    expect(prompt?.promptDetail?.act).toBe("写文案");
  });
});
