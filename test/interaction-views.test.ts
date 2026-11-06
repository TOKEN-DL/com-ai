/**
 * HTTP 边界：互动计数出现在详情与列表里，以及「我的收藏」的取数路径。
 *
 * 对应票 #8 验收标准第 2 条（详情页与列表页显示计数）
 * 与「我的收藏」页的两条取数路径（游客态本地 / 登录态服务端）。
 */
import { describe, expect, it } from "vitest";

import { POST as favoriteRoute } from "@/app/api/assets/[slug]/favorite/route";
import { POST as likeRoute } from "@/app/api/assets/[slug]/like/route";
import { GET as listAssets } from "@/app/api/assets/route";
import { GET as listFavorites } from "@/app/api/favorites/route";
import { GET as getSkill } from "@/app/api/skills/[slug]/route";
import { GET as listSkills } from "@/app/api/skills/route";
import { mergeGuestInteractionsToUser } from "@/lib/interactions";
import { prisma } from "@/lib/prisma";
import { hashSessionToken, SESSION_COOKIE } from "@/lib/session";

const DEVICE = "views-device-0001";
const SESSION_TOKEN = "views-session-token-0001";

async function seedSkill(slug: string): Promise<void> {
  await prisma.asset.create({
    data: { kind: "SKILL", slug, displayName: `Skill ${slug}`, license: "MIT" },
  });
}

async function seedUser(email: string): Promise<string> {
  const user = await prisma.user.create({ data: { email, emailVerifiedAt: new Date() } });
  await prisma.session.create({
    data: {
      userId: user.id,
      tokenHash: hashSessionToken(SESSION_TOKEN),
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  return user.id;
}

function guestRequest(path: string): Request {
  return new Request(`http://localhost${path}`, {
    headers: { "x-device-id": DEVICE },
  });
}

function sessionRequest(path: string): Request {
  return new Request(`http://localhost${path}`, {
    headers: { cookie: `${SESSION_COOKIE}=${SESSION_TOKEN}` },
  });
}

describe("详情与列表展示互动计数", () => {
  it("详情接口返回收藏数与点赞数", async () => {
    await seedSkill("views-detail-skill");

    await favoriteRoute(guestRequest("/api/assets/views-detail-skill/favorite"), {
      params: Promise.resolve({ slug: "views-detail-skill" }),
    });
    await likeRoute(guestRequest("/api/assets/views-detail-skill/like"), {
      params: Promise.resolve({ slug: "views-detail-skill" }),
    });

    const response = await getSkill(new Request("http://localhost/api/skills/x"), {
      params: Promise.resolve({ slug: "views-detail-skill" }),
    });

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.favoriteCount).toBe(1);
    expect(body.likeCount).toBe(1);
  });

  it("列表接口返回收藏数与点赞数", async () => {
    await seedSkill("views-list-skill");

    await favoriteRoute(guestRequest("/api/assets/views-list-skill/favorite"), {
      params: Promise.resolve({ slug: "views-list-skill" }),
    });

    const response = await listSkills(new Request("http://localhost/api/skills"));

    expect(response.status).toBe(200);

    const body = await response.json();
    const item = body.items.find((entry: { slug: string }) => entry.slug === "views-list-skill");
    expect(item.favoriteCount).toBe(1);
    expect(item.likeCount).toBe(0);
  });
});

describe("GET /api/favorites —— 我的收藏的取数路径", () => {
  it("未登录时返回 401 与用户可见的提示", async () => {
    await seedSkill("views-favorites-guest");

    const response = await listFavorites(guestRequest("/api/favorites"));

    expect(response.status).toBe(401);

    const body = await response.json();
    expect(body.error).toBe("unauthenticated");
    expect(body.message.length).toBeGreaterThan(0);
  });

  it("登录后从服务端读到账号自己的收藏", async () => {
    const userId = await seedUser("views-owner@example.com");
    await seedSkill("views-favorites-owned");
    await seedSkill("views-favorites-other");

    // 账号自己收藏的。
    await favoriteRoute(sessionRequest("/api/assets/views-favorites-owned/favorite"), {
      params: Promise.resolve({ slug: "views-favorites-owned" }),
    });

    const response = await listFavorites(sessionRequest("/api/favorites"));

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.items.map((item: { slug: string }) => item.slug)).toEqual([
      "views-favorites-owned",
    ]);

    const rows = await prisma.favorite.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);
  });

  it("游客收藏的内容在合并到账号后，能从服务端读到", async () => {
    const userId = await seedUser("views-merged@example.com");
    await seedSkill("views-favorites-merged");

    await favoriteRoute(guestRequest("/api/assets/views-favorites-merged/favorite"), {
      params: Promise.resolve({ slug: "views-favorites-merged" }),
    });

    // 合并前：服务端还看不到（游客态的清单在本地）。
    const before = await listFavorites(sessionRequest("/api/favorites"));
    expect((await before.json()).items).toEqual([]);

    await mergeGuestInteractionsToUser({ userId, deviceId: DEVICE });

    const after = await listFavorites(sessionRequest("/api/favorites"));
    const body = await after.json();
    expect(body.items.map((item: { slug: string }) => item.slug)).toEqual([
      "views-favorites-merged",
    ]);
  });
});

describe("GET /api/assets —— 按 slug 批量取资产", () => {
  it("返回请求到的资产，并保持请求顺序", async () => {
    await seedSkill("views-batch-b");
    await seedSkill("views-batch-a");

    const response = await listAssets(
      new Request("http://localhost/api/assets?slugs=views-batch-b,views-batch-a"),
    );

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.items.map((item: { slug: string }) => item.slug)).toEqual([
      "views-batch-b",
      "views-batch-a",
    ]);
  });

  it("不传 slug 时返回空列表", async () => {
    await seedSkill("views-batch-ignored");

    const response = await listAssets(new Request("http://localhost/api/assets"));

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.items).toEqual([]);
  });
});
