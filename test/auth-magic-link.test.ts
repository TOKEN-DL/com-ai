/**
 * 邮箱魔法链接登录（票 #9 主流程）。
 *
 * 验的是**外部可观察行为**（spec「Testing Decisions」）：
 *   - 请求登录链接 → 响应长什么样、库里落了什么；
 *   - 校验链接 → 拿到什么 cookie、账号是什么状态；
 *   - 链接一次性、有有效期；
 *   - 限流触发时给什么提示；
 *   - 登录后游客态互动有没有被正确合并（且**没有重复计数**）。
 *
 * 跑在**真实 Postgres** 上（spec 定的 HTTP 边界 seam）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST as verifyRoute } from "@/app/api/auth/verify/route";
import { POST as magicLinkRoute } from "@/app/api/auth/magic-link/route";
import { POST as favoriteRoute } from "@/app/api/assets/[slug]/favorite/route";
import { POST as likeRoute } from "@/app/api/assets/[slug]/like/route";
import { createRecordingEmailSender, setEmailSender } from "@/lib/email";
import { prisma } from "@/lib/prisma";

const DEVICE = "guest-device-auth-01";
const IP = "203.0.113.7";

/** 记录每次测试前的环境变量，测完还原 —— 别把配置漏给别的测试文件。 */
const ENV_KEYS = [
  "AUTH_BASE_URL",
  "AUTH_SESSION_SECRET",
  "AUTH_MAGIC_LINK_TTL_SECONDS",
  "AUTH_RATE_LIMIT_EMAIL_MAX",
  "AUTH_RATE_LIMIT_EMAIL_WINDOW_SECONDS",
  "AUTH_RATE_LIMIT_IP_MAX",
  "AUTH_RATE_LIMIT_IP_WINDOW_SECONDS",
  "GITHUB_OAUTH_CLIENT_ID",
  "GITHUB_OAUTH_CLIENT_SECRET",
] as const;

let savedEnv: Record<string, string | undefined> = {};

/** 请求一个登录链接，返回响应体与链接里的令牌。 */
async function requestMagicLink(email: string): Promise<{
  response: Response;
  body: { ok?: boolean; devLink?: string; message?: string; error?: string };
  token: string;
}> {
  const response = await magicLinkRoute(
    new Request("http://localhost/api/auth/magic-link", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": IP },
      body: JSON.stringify({ email }),
    }),
  );

  const body = (await response.json()) as {
    ok?: boolean;
    devLink?: string;
    message?: string;
    error?: string;
  };

  const token = body.devLink ? (new URL(body.devLink).searchParams.get("token") ?? "") : "";

  return { response, body, token };
}

/** 校验链接。 */
function verify(token: string, deviceId?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (deviceId) {
    headers["x-device-id"] = deviceId;
  }

  return new Request("http://localhost/api/auth/verify", {
    method: "POST",
    headers,
    body: JSON.stringify({ token }),
  });
}

/** 从 Set-Cookie 里取出会话令牌。 */
function sessionTokenFrom(response: Response): string | null {
  const cookie = response.headers.get("set-cookie");
  if (!cookie) {
    return null;
  }
  const match = /com-ai-session=([^;]+)/.exec(cookie);
  return match ? decodeURIComponent(match[1]) : null;
}

async function seedSkill(slug: string): Promise<string> {
  const asset = await prisma.asset.create({
    data: { kind: "SKILL", slug, displayName: `Skill ${slug}`, license: "MIT" },
  });
  return asset.id;
}

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  setEmailSender(createRecordingEmailSender());
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  setEmailSender(null);
});

describe("请求邮箱登录链接", () => {
  it("返回一个一次性链接，并把令牌（只存哈希）落库", async () => {
    const { response, body, token } = await requestMagicLink("User@Example.com");

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(token).not.toBe("");

    // 邮箱归一化：小写。
    const rows = await prisma.loginToken.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe("user@example.com");
    expect(rows[0].purpose).toBe("EMAIL_MAGIC");
    expect(rows[0].usedAt).toBeNull();
    expect(rows[0].expiresAt.getTime()).toBeGreaterThan(Date.now());

    // 明文令牌不进库 —— 库里只有它的哈希。
    expect(rows[0].tokenHash).not.toBe(token);
    expect(rows[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("链接带有效期", async () => {
    process.env.AUTH_MAGIC_LINK_TTL_SECONDS = "600";

    await requestMagicLink("ttl@example.com");

    const row = await prisma.loginToken.findFirstOrThrow();
    const ttlSeconds = Math.round((row.expiresAt.getTime() - Date.now()) / 1000);
    expect(ttlSeconds).toBeGreaterThan(500);
    expect(ttlSeconds).toBeLessThanOrEqual(600);
  });

  it("邮箱格式不合法时明确提示，不建令牌", async () => {
    const response = await magicLinkRoute(
      new Request("http://localhost/api/auth/magic-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "not-an-email" }),
      }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_email");
    expect(body.message).toContain("邮箱");
    expect(await prisma.loginToken.count()).toBe(0);
  });

  it("没配邮件服务时降级到控制台发送器，并把链接回显出来", async () => {
    setEmailSender(null);

    const { response, body } = await requestMagicLink("dev@example.com");

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    // 默认发送器是 console：不崩，而且明确告诉调用方「链接在回显里」。
    expect(body.devLink).toBeTruthy();
  });
});

describe("校验邮箱登录链接", () => {
  it("链接可用时建立会话，账号被创建且邮箱已验证", async () => {
    const { token } = await requestMagicLink("login@example.com");

    const response = await verifyRoute(verify(token));

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      user: { email: string };
    };
    expect(body.ok).toBe(true);
    expect(body.user.email).toBe("login@example.com");

    // 会话 cookie 发下来了。
    expect(sessionTokenFrom(response)).toBeTruthy();

    const user = await prisma.user.findUniqueOrThrow({ where: { email: "login@example.com" } });
    expect(user.emailVerifiedAt).not.toBeNull();

    // 会话行落库了（只存令牌哈希）。
    const sessions = await prisma.session.findMany();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].userId).toBe(user.id);
  });

  it("链接只能用一次：第二次一律拒绝", async () => {
    const { token } = await requestMagicLink("once@example.com");

    const first = await verifyRoute(verify(token));
    expect(first.status).toBe(200);

    const second = await verifyRoute(verify(token));
    expect(second.status).toBe(400);
    const body = (await second.json()) as { error: string; message: string };
    expect(body.error).toBe("used");
    expect(body.message).toContain("用过了");
  });

  it("链接过期后拒绝", async () => {
    const { token } = await requestMagicLink("expired@example.com");

    const row = await prisma.loginToken.findFirstOrThrow();
    await prisma.loginToken.update({
      where: { id: row.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const response = await verifyRoute(verify(token));

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("expired");
    expect(body.message).toContain("过期");

    // 过期链接不该建出账号。
    expect(await prisma.user.count()).toBe(0);
  });

  it("令牌对不上时拒绝", async () => {
    const response = await verifyRoute(verify("this-token-never-existed"));

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("invalid");
  });

  it("同一个邮箱再次登录复用同一个账号", async () => {
    const first = await requestMagicLink("same@example.com");
    await verifyRoute(verify(first.token));

    const second = await requestMagicLink("same@example.com");
    await verifyRoute(verify(second.token));

    expect(await prisma.user.count()).toBe(1);
  });
});

describe("请求登录链接的防滥用限流", () => {
  it("同一邮箱超过上限时返回 429 与明确提示", async () => {
    process.env.AUTH_RATE_LIMIT_EMAIL_MAX = "2";

    await requestMagicLink("flood@example.com");
    await requestMagicLink("flood@example.com");

    const { response, body } = await requestMagicLink("flood@example.com");

    expect(response.status).toBe(429);
    expect(body.error).toBe("rate_limited");
    expect(body.message).toContain("太频繁");
    expect(response.headers.get("retry-after")).toBeTruthy();

    // 超限的请求不该再建令牌。
    expect(await prisma.loginToken.count()).toBe(2);
  });

  it("同一 IP 超过上限时返回 429 与明确提示", async () => {
    process.env.AUTH_RATE_LIMIT_IP_MAX = "1";
    process.env.AUTH_RATE_LIMIT_EMAIL_MAX = "100";

    await requestMagicLink("ip-a@example.com");
    const { response, body } = await requestMagicLink("ip-b@example.com");

    expect(response.status).toBe(429);
    expect(body.error).toBe("rate_limited");
    expect(body.message).toContain("太频繁");
  });

  it("不同 IP 的同一邮箱各自计数（不互相牵连）", async () => {
    process.env.AUTH_RATE_LIMIT_EMAIL_MAX = "1";

    await magicLinkRoute(
      new Request("http://localhost/api/auth/magic-link", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.1" },
        body: JSON.stringify({ email: "shared@example.com" }),
      }),
    );

    const second = await magicLinkRoute(
      new Request("http://localhost/api/auth/magic-link", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.2" },
        body: JSON.stringify({ email: "shared@example.com" }),
      }),
    );

    // 同一邮箱的上限是按邮箱算的，所以第二个 IP 也被拒 —— 这正是「同一邮箱」的闸门。
    expect(second.status).toBe(429);
  });
});

describe("登录后合并游客态互动", () => {
  it("游客收藏与点赞迁到账号名下，计数不翻倍", async () => {
    const slug = "auth-merge-skill";
    const assetId = await seedSkill(slug);

    // 游客态先互动（走真实的 HTTP 路径）。
    await favoriteRoute(
      new Request(`http://localhost/api/assets/${slug}/favorite`, {
        method: "POST",
        headers: { "x-device-id": DEVICE },
      }),
      { params: Promise.resolve({ slug }) },
    );
    await likeRoute(
      new Request(`http://localhost/api/assets/${slug}/like`, {
        method: "POST",
        headers: { "x-device-id": DEVICE },
      }),
      { params: Promise.resolve({ slug }) },
    );

    const before = await prisma.asset.findUniqueOrThrow({ where: { id: assetId } });
    expect(before.favoriteCount).toBe(1);
    expect(before.likeCount).toBe(1);

    // 登录（带上同一个设备指纹 —— 设备指纹原文由服务端自己哈希）。
    const { token } = await requestMagicLink("merge@example.com");
    const response = await verifyRoute(verify(token, DEVICE));

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      merged: { favorites: number; likes: number };
    };
    expect(body.merged.favorites).toBe(1);
    expect(body.merged.likes).toBe(1);

    // 计数不翻倍：一条互动还是一条。
    const after = await prisma.asset.findUniqueOrThrow({ where: { id: assetId } });
    expect(after.favoriteCount).toBe(1);
    expect(after.likeCount).toBe(1);

    // 归属换成了账号。
    const favorites = await prisma.favorite.findMany();
    expect(favorites).toHaveLength(1);
    expect(favorites[0].deviceId).toBeNull();
    expect(favorites[0].userId).not.toBeNull();

    const likes = await prisma.like.findMany();
    expect(likes).toHaveLength(1);
    expect(likes[0].deviceId).toBeNull();
    expect(likes[0].userId).not.toBeNull();
  });

  it("账号本来就收藏过同一资产时合并去重，计数不翻倍", async () => {
    const slug = "auth-merge-dedup-skill";
    const assetId = await seedSkill(slug);

    // 游客态先收藏一次。
    await favoriteRoute(
      new Request(`http://localhost/api/assets/${slug}/favorite`, {
        method: "POST",
        headers: { "x-device-id": DEVICE },
      }),
      { params: Promise.resolve({ slug }) },
    );

    // 第一次登录：游客那条收藏迁到账号名下。
    const first = await requestMagicLink("dedup@example.com");
    const firstResponse = await verifyRoute(verify(first.token, DEVICE));
    expect(firstResponse.status).toBe(200);
    const firstBody = (await firstResponse.json()) as {
      merged: { favorites: number };
      user: { id: string };
    };
    expect(firstBody.merged.favorites).toBe(1);

    // 游客态又收藏了一次（此时设备名下重新有了一条，账号名下也有一条）。
    await favoriteRoute(
      new Request(`http://localhost/api/assets/${slug}/favorite`, {
        method: "POST",
        headers: { "x-device-id": DEVICE },
      }),
      { params: Promise.resolve({ slug }) },
    );

    const before = await prisma.asset.findUniqueOrThrow({ where: { id: assetId } });
    expect(before.favoriteCount).toBe(2);

    // 第二次登录（同一个账号）：合并时应当去重，计数回落一条而不是翻倍。
    const second = await requestMagicLink("dedup@example.com");
    const secondResponse = await verifyRoute(verify(second.token, DEVICE));
    const secondBody = (await secondResponse.json()) as {
      merged: { favorites: number; favoritesDeduplicated: number };
    };

    expect(secondBody.merged.favorites).toBe(0);
    expect(secondBody.merged.favoritesDeduplicated).toBe(1);

    const after = await prisma.asset.findUniqueOrThrow({ where: { id: assetId } });
    expect(after.favoriteCount).toBe(1);
    expect(await prisma.favorite.count({ where: { assetId } })).toBe(1);
  });
});
