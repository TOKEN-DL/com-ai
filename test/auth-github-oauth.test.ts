/**
 * GitHub OAuth 备选登录（票 #9 验收标准第 4 条）。
 *
 * 两件事必须成立：
 *   1. **没有客户端凭据时优雅降级** —— 页面说明未配置、接口给 503，绝不崩；
 *   2. **能完成登录并正确关联到同一个账号** —— 邮箱相同的 GitHub 账号与站内账号
 *      必须是同一个账号，不是两个。
 *
 * GitHub 的接口在测试里被替换成假实现（不打真实网络）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as githubRoute } from "@/app/api/auth/github/route";
import { GET as callbackRoute } from "@/app/api/auth/github/callback/route";
import { prisma } from "@/lib/prisma";

const ENV_KEYS = [
  "GITHUB_OAUTH_CLIENT_ID",
  "GITHUB_OAUTH_CLIENT_SECRET",
  "GITHUB_OAUTH_REDIRECT_URI",
  "AUTH_BASE_URL",
  "AUTH_RATE_LIMIT_IP_MAX",
  "AUTH_RATE_LIMIT_EMAIL_MAX",
] as const;

let savedEnv: Record<string, string | undefined> = {};

/** 假 GitHub：只认这三个端点，其余一律报错（说明代码打错了地方）。 */
function stubGitHub(profile: { login: string; email: string | null; name?: string | null }) {
  const mock = vi.fn(async (input: unknown) => {
    const url = String(input);

    if (url.includes("login/oauth/access_token")) {
      return new Response(JSON.stringify({ access_token: "gho_fake_token" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.includes("api.github.com/user/emails")) {
      return new Response(
        JSON.stringify([{ email: profile.email, primary: true, verified: true }]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    if (url.includes("api.github.com/user")) {
      return new Response(
        JSON.stringify({
          login: profile.login,
          name: profile.name ?? null,
          avatar_url: null,
          email: profile.email,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    throw new Error(`不该请求这个地址：${url}`);
  });

  vi.stubGlobal("fetch", mock);
  return mock;
}

/** 发起 GitHub 登录，返回带 state 的授权地址。 */
async function startGithubLogin(): Promise<string> {
  const response = await githubRoute(new Request("http://localhost/api/auth/github"));
  return response.headers.get("location") ?? "";
}

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.GITHUB_OAUTH_CLIENT_ID = "client-id-fake";
  process.env.GITHUB_OAUTH_CLIENT_SECRET = "client-secret-fake";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  vi.unstubAllGlobals();
});

describe("GitHub OAuth 没配客户端凭据时", () => {
  it("接口返回 503 与明确提示，不抛异常", async () => {
    delete process.env.GITHUB_OAUTH_CLIENT_ID;
    delete process.env.GITHUB_OAUTH_CLIENT_SECRET;

    const response = await githubRoute(new Request("http://localhost/api/auth/github"));

    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("not_configured");
    expect(body.message).toContain("未配置");
  });

  it("回调接口同样优雅降级", async () => {
    delete process.env.GITHUB_OAUTH_CLIENT_ID;
    delete process.env.GITHUB_OAUTH_CLIENT_SECRET;

    const response = await callbackRoute(
      new Request("http://localhost/api/auth/github/callback?code=x&state=y"),
    );

    expect(response.status).toBe(503);
  });
});

describe("GitHub OAuth 登录流程", () => {
  it("发起登录时跳转到 GitHub 授权页，并记下一次性的 state", async () => {
    const location = await startGithubLogin();

    const url = new URL(location);
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-id-fake");
    expect(url.searchParams.get("scope")).toContain("user:email");
    expect(url.searchParams.get("state")).toBeTruthy();

    const rows = await prisma.loginToken.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].purpose).toBe("GITHUB_OAUTH");
    expect(rows[0].usedAt).toBeNull();
  });

  it("回调后建立会话并创建账号", async () => {
    stubGitHub({ login: "octocat", email: "octocat@example.com", name: "Octo Cat" });

    const location = await startGithubLogin();
    const state = new URL(location).searchParams.get("state") ?? "";

    const response = await callbackRoute(
      new Request(`http://localhost/api/auth/github/callback?code=the-code&state=${state}`),
    );

    expect(response.status).toBe(307);

    const user = await prisma.user.findUniqueOrThrow({ where: { email: "octocat@example.com" } });
    expect(user.githubLogin).toBe("octocat");
    expect(user.emailVerifiedAt).not.toBeNull();

    // 会话 cookie 发下来了。
    const cookie = response.headers.get("set-cookie");
    expect(cookie).toContain("com-ai-session=");

    // state 一次性：用掉了。
    const row = await prisma.loginToken.findFirstOrThrow();
    expect(row.usedAt).not.toBeNull();
  });

  it("邮箱相同的 GitHub 账号关联到同一个站内账号", async () => {
    // 站内已经有一个用这个邮箱注册的账号（还没绑 GitHub）。
    const existing = await prisma.user.create({
      data: { email: "same@example.com", emailVerifiedAt: new Date() },
    });

    stubGitHub({ login: "same-user", email: "same@example.com" });

    const location = await startGithubLogin();
    const state = new URL(location).searchParams.get("state") ?? "";

    await callbackRoute(
      new Request(`http://localhost/api/auth/github/callback?code=the-code&state=${state}`),
    );

    // 没有多出第二个账号，而是把 GitHub 绑到了原来那个上。
    expect(await prisma.user.count()).toBe(1);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: existing.id } });
    expect(user.githubLogin).toBe("same-user");
  });

  it("state 只能用一次：重复回调拿不到会话", async () => {
    stubGitHub({ login: "octocat", email: "octocat@example.com" });

    const location = await startGithubLogin();
    const state = new URL(location).searchParams.get("state") ?? "";

    const first = await callbackRoute(
      new Request(`http://localhost/api/auth/github/callback?code=the-code&state=${state}`),
    );
    expect(first.status).toBe(307);
    expect(first.headers.get("set-cookie")).toContain("com-ai-session=");

    const second = await callbackRoute(
      new Request(`http://localhost/api/auth/github/callback?code=the-code&state=${state}`),
    );
    expect(second.status).toBe(307);
    expect(second.headers.get("set-cookie")).toBeNull();
    expect(second.headers.get("location")).toContain("status=used");
  });

  it("GitHub 换令牌失败时回到登录页并说明原因，不抛异常", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 401 })),
    );

    const location = await startGithubLogin();
    const state = new URL(location).searchParams.get("state") ?? "";

    const response = await callbackRoute(
      new Request(`http://localhost/api/auth/github/callback?code=bad&state=${state}`),
    );

    expect(response.status).toBe(307);
    const target = new URL(response.headers.get("location") ?? "");
    expect(target.searchParams.get("status")).toBe("github_error");
    expect(target.searchParams.get("message")).toBeTruthy();
  });
});
