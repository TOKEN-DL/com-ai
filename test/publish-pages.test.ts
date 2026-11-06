/**
 * 发布页与「我的发布」页的渲染（票 #11）。
 *
 * HTTP 边界测不到「页面上到底显示了什么」—— 得看渲染出来的 HTML。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/prisma";
import { createSession, SESSION_COOKIE } from "@/lib/session";

/** 伪造 next/headers 的 cookies()：测试里自己控制登录态。 */
const { cookieStore } = vi.hoisted(() => ({
  cookieStore: { tokens: new Map<string, string>() },
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieStore.tokens.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));

import MyPublishPage from "@/app/publish/mine/page";
import PublishPage from "@/app/publish/page";

beforeEach(() => {
  cookieStore.tokens.clear();
});

afterEach(() => {
  cookieStore.tokens.clear();
});

describe("发布页", () => {
  it("登录用户看到发布表单：类型、名称、仓库、许可证、简介", async () => {
    const user = await prisma.user.create({
      data: { email: "form@example.com", emailVerifiedAt: new Date() },
    });
    const { token } = await createSession({ userId: user.id });
    cookieStore.tokens.set(SESSION_COOKIE, token);

    const html = renderToStaticMarkup(await PublishPage());

    expect(html).toContain("资产类型");
    expect(html).toContain("仓库地址");
    expect(html).toContain("许可证");
    expect(html).toContain("简介");
    expect(html).toContain("SKILL");
    expect(html).toContain("MCP");
    expect(html).toContain("PROMPT");
  });

  it("未登录用户进不了发布流程：被重定向到登录页", async () => {
    await expect(PublishPage()).rejects.toThrow(/NEXT_REDIRECT/);
  });
});

describe("我的发布页", () => {
  it("看得到发布状态与审核意见", async () => {
    const user = await prisma.user.create({
      data: { email: "mine-page@example.com", emailVerifiedAt: new Date() },
    });
    const { token } = await createSession({ userId: user.id });
    cookieStore.tokens.set(SESSION_COOKIE, token);

    const asset = await prisma.asset.create({
      data: {
        kind: "SKILL",
        slug: "page-skill",
        displayName: "页面上的 Skill",
        license: "mit",
        sourceId: "user",
      },
    });
    await prisma.userPublishedAsset.create({
      data: {
        userId: user.id,
        assetId: asset.id,
        status: "REJECTED",
        reviewNote: "仓库里没有 SKILL.md。",
        note: "我写的简介",
      },
    });

    const html = renderToStaticMarkup(await MyPublishPage());

    expect(html).toContain("页面上的 Skill");
    expect(html).toContain("已拒绝");
    expect(html).toContain("仓库里没有 SKILL.md。");
  });

  it("未登录用户进不了「我的发布」：被重定向到登录页", async () => {
    await expect(MyPublishPage()).rejects.toThrow(/NEXT_REDIRECT/);
  });
});
