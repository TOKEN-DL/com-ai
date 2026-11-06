/**
 * Seam 2 —— HTTP 边界：游客态点赞与收藏（票 #8 验收标准 1~4）。
 *
 * 路由处理器对着**真实测试 Postgres** 跑（不用内存替身）。
 *
 * 关注四件事：
 *   1. 未登录访客能点赞 / 收藏，且刷新后状态保持（设备指纹 + 服务端行）；
 *   2. 同一设备重复点击不会重复计数；
 *   3. 同一 IP 在时间窗内对同一资产的互动有上限，超出时给出**用户可见的提示**；
 *   4. 计数不会被绕过服务层的直接写库带偏（计数由数据库触发器维护）。
 */
import { describe, expect, it } from "vitest";

import {
  DELETE as unfavoriteRoute,
  POST as favoriteRoute,
} from "@/app/api/assets/[slug]/favorite/route";
import { GET as getInteractionStatus } from "@/app/api/assets/[slug]/interaction/route";
import {
  DELETE as unlikeRoute,
  POST as likeRoute,
} from "@/app/api/assets/[slug]/like/route";
import { prisma } from "@/lib/prisma";

/** 游客态设备指纹：浏览器本地生成的随机 id（原文）。 */
const DEVICE_A = "device-a-11111111";
const DEVICE_B = "device-b-22222222";

/** 同一 IP 在时间窗内对同一资产的互动上限（默认值，见 src/lib/guest-identity.ts）。 */
const RATE_LIMIT = 10;

async function seedSkill(slug: string): Promise<string> {
  const asset = await prisma.asset.create({
    data: { kind: "SKILL", slug, displayName: `Skill ${slug}`, license: "MIT" },
  });
  return asset.id;
}

type CallInit = {
  deviceId?: string;
  ip?: string;
  method?: string;
};

function call(path: string, init: CallInit = {}): Request {
  const headers = new Headers();
  if (init.deviceId) {
    headers.set("x-device-id", init.deviceId);
  }
  if (init.ip) {
    headers.set("x-forwarded-for", init.ip);
  }
  return new Request(`http://localhost${path}`, { method: init.method ?? "POST", headers });
}

function likeParams(slug: string) {
  return { params: Promise.resolve({ slug }) };
}

describe("游客态点赞", () => {
  it("未登录访客可以点赞，计数 +1，刷新后状态保持", async () => {
    const slug = "guest-like-skill";
    const assetId = await seedSkill(slug);

    const response = await likeRoute(
      call(`/api/assets/${slug}/like`, { deviceId: DEVICE_A, ip: "203.0.113.5" }),
      likeParams(slug),
    );

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.liked).toBe(true);
    expect(body.likeCount).toBe(1);

    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: assetId } });
    expect(asset.likeCount).toBe(1);

    // 刷新页面：按钮状态与计数都还在。
    const status = await getInteractionStatus(
      call(`/api/assets/${slug}/interaction`, { deviceId: DEVICE_A, method: "GET" }),
      likeParams(slug),
    );
    const statusBody = await status.json();
    expect(statusBody.liked).toBe(true);
    expect(statusBody.likeCount).toBe(1);
  });

  it("同一设备重复点击不会重复计数", async () => {
    const slug = "guest-like-idempotent";
    const assetId = await seedSkill(slug);

    await likeRoute(call(`/api/assets/${slug}/like`, { deviceId: DEVICE_A }), likeParams(slug));
    await likeRoute(call(`/api/assets/${slug}/like`, { deviceId: DEVICE_A }), likeParams(slug));

    expect(await prisma.like.count()).toBe(1);
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: assetId } });
    expect(asset.likeCount).toBe(1);
  });

  it("两个设备各点一次，计数是 2", async () => {
    const slug = "guest-like-two-devices";
    const assetId = await seedSkill(slug);

    await likeRoute(call(`/api/assets/${slug}/like`, { deviceId: DEVICE_A }), likeParams(slug));
    await likeRoute(call(`/api/assets/${slug}/like`, { deviceId: DEVICE_B }), likeParams(slug));

    expect(await prisma.like.count()).toBe(2);
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: assetId } });
    expect(asset.likeCount).toBe(2);
  });

  it("取消点赞后计数回落", async () => {
    const slug = "guest-unlike";
    const assetId = await seedSkill(slug);

    await likeRoute(call(`/api/assets/${slug}/like`, { deviceId: DEVICE_A }), likeParams(slug));
    const response = await unlikeRoute(
      call(`/api/assets/${slug}/like`, { deviceId: DEVICE_A, method: "DELETE" }),
      likeParams(slug),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.liked).toBe(false);
    expect(body.likeCount).toBe(0);

    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: assetId } });
    expect(asset.likeCount).toBe(0);
    expect(await prisma.like.count()).toBe(0);
  });
});

describe("游客态收藏", () => {
  it("未登录访客可以收藏，计数 +1，刷新后状态保持", async () => {
    const slug = "guest-favorite-skill";
    const assetId = await seedSkill(slug);

    const response = await favoriteRoute(
      call(`/api/assets/${slug}/favorite`, { deviceId: DEVICE_A, ip: "203.0.113.5" }),
      likeParams(slug),
    );

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.favorited).toBe(true);
    expect(body.favoriteCount).toBe(1);

    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: assetId } });
    expect(asset.favoriteCount).toBe(1);

    const status = await getInteractionStatus(
      call(`/api/assets/${slug}/interaction`, { deviceId: DEVICE_A, method: "GET" }),
      likeParams(slug),
    );
    const statusBody = await status.json();
    expect(statusBody.favorited).toBe(true);
    expect(statusBody.favoriteCount).toBe(1);
  });

  it("同一设备重复收藏不会重复计数", async () => {
    const slug = "guest-favorite-idempotent";
    const assetId = await seedSkill(slug);

    await favoriteRoute(call(`/api/assets/${slug}/favorite`, { deviceId: DEVICE_A }), likeParams(slug));
    await favoriteRoute(call(`/api/assets/${slug}/favorite`, { deviceId: DEVICE_A }), likeParams(slug));

    expect(await prisma.favorite.count()).toBe(1);
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: assetId } });
    expect(asset.favoriteCount).toBe(1);
  });

  it("取消收藏后计数回落", async () => {
    const slug = "guest-unfavorite";
    const assetId = await seedSkill(slug);

    await favoriteRoute(call(`/api/assets/${slug}/favorite`, { deviceId: DEVICE_A }), likeParams(slug));
    const response = await unfavoriteRoute(
      call(`/api/assets/${slug}/favorite`, { deviceId: DEVICE_A, method: "DELETE" }),
      likeParams(slug),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.favorited).toBe(false);
    expect(body.favoriteCount).toBe(0);

    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: assetId } });
    expect(asset.favoriteCount).toBe(0);
  });
});

describe("游客态限流", () => {
  it("同一 IP 在时间窗内对同一资产点赞超过上限会被拦下，并给出用户可见的提示", async () => {
    const slug = "guest-like-rate-limited";
    const assetId = await seedSkill(slug);
    const ip = "203.0.113.99";

    for (let index = 0; index < RATE_LIMIT; index += 1) {
      const response = await likeRoute(
        call(`/api/assets/${slug}/like`, { deviceId: `device-${index}-000000`, ip }),
        likeParams(slug),
      );
      expect(response.status).toBe(200);
    }

    const blocked = await likeRoute(
      call(`/api/assets/${slug}/like`, { deviceId: "device-over-limit", ip }),
      likeParams(slug),
    );

    expect(blocked.status).toBe(429);

    const body = await blocked.json();
    expect(body.error).toBe("rate_limited");
    // 限流必须**看得见**：提示文案不能为空。
    expect(typeof body.message).toBe("string");
    expect(body.message.length).toBeGreaterThan(0);

    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: assetId } });
    expect(asset.likeCount).toBe(RATE_LIMIT);
  });

  it("伪造 x-forwarded-for 的左侧段绕不过限流（只认最右一跳）", async () => {
    const slug = "guest-like-spoofed-xff";
    await seedSkill(slug);
    const realIp = "203.0.113.7";

    for (let index = 0; index < RATE_LIMIT; index += 1) {
      const response = await likeRoute(
        call(`/api/assets/${slug}/like`, {
          deviceId: `spoof-device-${index}`,
          ip: `10.0.0.${index}, ${realIp}`,
        }),
        likeParams(slug),
      );
      expect(response.status).toBe(200);
    }

    const blocked = await likeRoute(
      call(`/api/assets/${slug}/like`, { deviceId: "spoof-device-over", ip: `10.0.0.99, ${realIp}` }),
      likeParams(slug),
    );

    expect(blocked.status).toBe(429);
  });

  it("IP 只以哈希落库，不存明文", async () => {
    const slug = "guest-like-ip-hashed";
    await seedSkill(slug);
    const ip = "198.51.100.42";

    await likeRoute(call(`/api/assets/${slug}/like`, { deviceId: DEVICE_A, ip }), likeParams(slug));

    const row = await prisma.like.findFirstOrThrow({ where: { deviceId: { not: null } } });
    expect(row.ipHash).not.toBeNull();
    expect(row.ipHash).not.toBe(ip);
    expect(row.ipHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("缺少设备标识时给出可读的提示", async () => {
    const slug = "guest-like-no-device";
    await seedSkill(slug);

    const response = await likeRoute(call(`/api/assets/${slug}/like`), likeParams(slug));

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("missing_device_id");
    expect(body.message.length).toBeGreaterThan(0);
    expect(await prisma.like.count()).toBe(0);
  });
});

describe("计数一致性", () => {
  it("绕过服务层直接写库，计数也不会漂移", async () => {
    const slug = "guest-like-no-drift";
    const assetId = await seedSkill(slug);

    await prisma.favorite.create({
      data: { assetId, actorKey: "device:direct-write", deviceId: "direct-write" },
    });

    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: assetId } });
    expect(asset.favoriteCount).toBe(1);

    await prisma.favorite.delete({ where: { assetId_actorKey: { assetId, actorKey: "device:direct-write" } } });

    const reread = await prisma.asset.findUniqueOrThrow({ where: { id: assetId } });
    expect(reread.favoriteCount).toBe(0);
  });
});
