/**
 * 登录页与导航栏的渲染（票 #9：登录态要在导航与页面上正确反映）。
 *
 * 这一条在 HTTP 边界上测不到 —— 页面上到底显示了什么，得看渲染出来的 HTML。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuthNav } from "@/app/AuthNav";
import LoginPage from "@/app/login/page";

const ENV_KEYS = ["GITHUB_OAUTH_CLIENT_ID", "GITHUB_OAUTH_CLIENT_SECRET"] as const;
let savedEnv: Record<string, string | undefined> = {};

async function renderLogin(params: Record<string, string> = {}): Promise<string> {
  return renderToStaticMarkup(
    await LoginPage({ searchParams: Promise.resolve(params) }),
  );
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

describe("登录页", () => {
  it("提供邮箱登录入口，并说明是免密码的一次性链接", async () => {
    const html = await renderLogin();

    expect(html).toContain("用邮箱登录");
    expect(html).toContain("发送登录链接");
    expect(html).toContain("一次性");
    expect(html).toContain('type="email"');
  });

  it("当前环境未配置邮件服务时明确说出来", async () => {
    const html = await renderLogin();

    expect(html).toContain("未配置邮件服务");
    expect(html).toContain("服务端日志");
  });

  it("GitHub OAuth 未配置时按钮置灰并说明原因", async () => {
    const html = await renderLogin();

    expect(html).toContain("未配置 GitHub OAuth 客户端");
    expect(html).toContain("GitHub 登录暂不可用");
  });

  it("GitHub OAuth 已配置时给出登录入口", async () => {
    process.env.GITHUB_OAUTH_CLIENT_ID = "id";
    process.env.GITHUB_OAUTH_CLIENT_SECRET = "secret";

    const html = await renderLogin();

    expect(html).toContain('href="/api/auth/github"');
    expect(html).not.toContain("GitHub 登录暂不可用");
  });

  it("链接失效时把原因说出来", async () => {
    const html = await renderLogin({ status: "expired" });

    expect(html).toContain("已过期");
  });

  it("合并了游客态互动时告诉用户合并了多少条", async () => {
    const html = await renderLogin({ status: "ok", mergedFavorites: "3", mergedLikes: "2" });

    expect(html).toContain("登录成功");
    expect(html).toContain("已合并 3 条收藏");
    expect(html).toContain("2 条点赞");
  });

  it("合并时去重掉的条数也说出来", async () => {
    const html = await renderLogin({
      status: "ok",
      mergedFavorites: "3",
      mergedFavoritesDeduplicated: "1",
    });

    expect(html).toContain("已去重");
  });
});

describe("导航栏的登录态", () => {
  it("未登录时给出登录入口", async () => {
    const html = renderToStaticMarkup(createElement(AuthNav));

    expect(html).toContain('href="/login"');
    expect(html).toContain("登录");
  });
});
