/**
 * 会话与令牌（票 #9 验收标准第 5 条）。
 *
 * 验的是外部可观察行为：
 *   - 会话有效时受保护接口能拿到数据；
 *   - 会话过期后**行为正确且不泄漏敏感数据**（401 + 引导登录，响应里没有用户信息）；
 *   - 登出后令牌**真的失效**（不是只删 cookie）；
 *   - 伪造 / 篡改的令牌一律当游客态。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET as favoritesRoute } from "@/app/api/favorites/route";
import { GET as meRoute } from "@/app/api/auth/me/route";
import { POST as logoutRoute } from "@/app/api/auth/logout/route";
import { POST as favoriteRoute } from "@/app/api/assets/[slug]/favorite/route";
import { createSession, getSessionUser, SESSION_COOKIE } from "@/lib/session";
import { prisma } from "@/lib/prisma";

const ENV_KEYS = ["AUTH_SESSION_SECRET", "AUTH_SESSION_TTL_SECONDS"] as const;
let savedEnv: Record<string, string | undefined> = {};

/** 造一个带会话 cookie 的请求。 */
function withCookie(token: string): Request {
  return new Request("http://localhost/api/favorites", {
    headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
  });
}

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

describe("会话读写", () => {
  it("会话有效时能认出用户", async () => {
    const user = await prisma.user.create({
      data: { email: "session@example.com", emailVerifiedAt: new Date() },
    });

    const { token } = await createSession({ userId: user.id });
    const session = await getSessionUser(withCookie(token));

    expect(session).not.toBeNull();
    expect(session?.id).toBe(user.id);
    expect(session?.email).toBe("session@example.com");
  });

  it("没有 cookie 时是游客态", async () => {
    const session = await getSessionUser(new Request("http://localhost/"));
    expect(session).toBeNull();
  });

  it("令牌对不上时是游客态", async () => {
    const session = await getSessionUser(withCookie("not-a-real-token"));
    expect(session).toBeNull();
  });

  it("令牌被篡改时是游客态", async () => {
    const user = await prisma.user.create({
      data: { email: "tamper@example.com", emailVerifiedAt: new Date() },
    });
    const { token } = await createSession({ userId: user.id });

    // 改掉签名部分。
    const tampered = `${token.slice(0, -3)}abc`;

    expect(await getSessionUser(withCookie(tampered))).toBeNull();
  });

  it("会话过期后是游客态", async () => {
    const user = await prisma.user.create({
      data: { email: "expired@example.com", emailVerifiedAt: new Date() },
    });
    const { token } = await createSession({ userId: user.id });

    const row = await prisma.session.findFirstOrThrow();
    await prisma.session.update({
      where: { id: row.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    expect(await getSessionUser(withCookie(token))).toBeNull();
  });

  it("会话行被删掉后立刻失效（服务端说了算）", async () => {
    const user = await prisma.user.create({
      data: { email: "revoked@example.com", emailVerifiedAt: new Date() },
    });
    const { token } = await createSession({ userId: user.id });

    expect(await getSessionUser(withCookie(token))).not.toBeNull();

    await prisma.session.deleteMany();

    expect(await getSessionUser(withCookie(token))).toBeNull();
  });
});

describe("会话过期后的受保护操作", () => {
  it("过期会话访问「我的收藏」返回 401 并引导登录，且不泄漏任何用户数据", async () => {
    const user = await prisma.user.create({
      data: { email: "leak@example.com", emailVerifiedAt: new Date() },
    });
    const { token } = await createSession({ userId: user.id });

    const row = await prisma.session.findFirstOrThrow();
    await prisma.session.update({
      where: { id: row.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const response = await favoritesRoute(withCookie(token));

    expect(response.status).toBe(401);
    const body = (await response.json()) as {
      error: string;
      message: string;
      loginUrl: string;
      items?: unknown;
    };
    expect(body.error).toBe("unauthenticated");
    expect(body.loginUrl).toBe("/login");
    expect(body.message).toContain("登录");
    // 不泄漏：没有收藏清单、没有用户信息。
    expect(body.items).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("leak@example.com");
  });

  it("有效会话访问「我的收藏」返回自己的收藏", async () => {
    const user = await prisma.user.create({
      data: { email: "mine@example.com", emailVerifiedAt: new Date() },
    });
    const { token } = await createSession({ userId: user.id });

    const response = await favoritesRoute(withCookie(token));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });
});

describe("登出", () => {
  it("清掉 cookie，并让会话在服务端失效", async () => {
    const user = await prisma.user.create({
      data: { email: "bye@example.com", emailVerifiedAt: new Date() },
    });
    const { token } = await createSession({ userId: user.id });

    const response = await logoutRoute(withCookie(token));

    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie");
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cookie).toContain("Max-Age=0");

    // 服务端那一行没了 —— 重放旧令牌也不管用。
    expect(await prisma.session.count()).toBe(0);
    expect(await getSessionUser(withCookie(token))).toBeNull();
  });
});

describe("登录态被互动路径认出", () => {
  it("带着会话的互动归属账号，而不是设备指纹", async () => {
    const user = await prisma.user.create({
      data: { email: "actor@example.com", emailVerifiedAt: new Date() },
    });
    const { token } = await createSession({ userId: user.id });

    await prisma.asset.create({
      data: { kind: "SKILL", slug: "actor-skill", displayName: "Actor Skill", license: "MIT" },
    });

    const response = await favoriteRoute(
      new Request("http://localhost/api/assets/actor-skill/favorite", {
        method: "POST",
        headers: {
          cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
          "x-device-id": "actor-device-0001",
        },
      }),
      { params: Promise.resolve({ slug: "actor-skill" }) },
    );

    expect(response.status).toBe(200);

    const rows = await prisma.favorite.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(user.id);
    expect(rows[0].deviceId).toBeNull();
  });
});

describe("登录态查询", () => {  it("游客态返回未登录", async () => {
    const response = await meRoute(new Request("http://localhost/api/auth/me"));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { authenticated: boolean; user: unknown };
    expect(body.authenticated).toBe(false);
    expect(body.user).toBeNull();
  });

  it("登录态返回用户自己的信息", async () => {
    const user = await prisma.user.create({
      data: { email: "who@example.com", emailVerifiedAt: new Date() },
    });
    const { token } = await createSession({ userId: user.id });

    const response = await meRoute(withCookie(token));

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      authenticated: boolean;
      user: { id: string; email: string };
    };
    expect(body.authenticated).toBe(true);
    expect(body.user.id).toBe(user.id);
    expect(body.user.email).toBe("who@example.com");
  });
});
