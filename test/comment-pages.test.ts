/**
 * 页面渲染：评论列表与回复列表真的出现在详情页上（票 #10 验收标准第 2 条）。
 *
 * 这一条在 HTTP 边界上测不到 —— 页面上显示了什么，得看渲染出来的 HTML。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import OpsCommentsPage from "@/app/ops/comments/page";
import OpsReportsPage from "@/app/ops/reports/page";
import SkillDetailPage from "@/app/skills/[slug]/page";
import { prisma } from "@/lib/prisma";

const SLUG = "page-comment-skill";

async function seedThread(): Promise<void> {
  const asset = await prisma.asset.create({
    data: { kind: "SKILL", slug: SLUG, displayName: "页面评论 Skill", license: "MIT" },
  });
  const user = await prisma.user.create({
    data: { email: "page@example.com", emailVerifiedAt: new Date(), displayName: "页面用户" },
  });

  const top = await prisma.comment.create({
    data: { assetId: asset.id, userId: user.id, body: "顶层评论内容", status: "VISIBLE" },
  });

  await prisma.comment.create({
    data: {
      assetId: asset.id,
      userId: user.id,
      body: "回复内容",
      status: "VISIBLE",
      parentId: top.id,
    },
  });
}

describe("详情页展示评论与回复", () => {
  it("顶层评论与它的回复都出现在页面上", async () => {
    await seedThread();

    const html = renderToStaticMarkup(
      await SkillDetailPage({ params: Promise.resolve({ slug: SLUG }) }),
    );

    expect(html).toContain("评论");
    expect(html).toContain("顶层评论内容");
    expect(html).toContain("回复内容");
  });

  it("待抽查与被隐藏的评论不展示在页面上", async () => {
    await seedThread();

    const asset = await prisma.asset.findUniqueOrThrow({ where: { slug: SLUG } });
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "page@example.com" } });

    await prisma.comment.create({
      data: {
        assetId: asset.id,
        userId: user.id,
        body: "待抽查内容",
        status: "PENDING",
        filteredReason: "加微信",
      },
    });
    await prisma.comment.create({
      data: { assetId: asset.id, userId: user.id, body: "已隐藏内容", status: "HIDDEN" },
    });

    const html = renderToStaticMarkup(
      await SkillDetailPage({ params: Promise.resolve({ slug: SLUG }) }),
    );

    expect(html).not.toContain("待抽查内容");
    expect(html).not.toContain("已隐藏内容");
  });

  it("评论正文里的脚本标签被转义，不会作为标记出现在页面上", async () => {
    await seedThread();

    const asset = await prisma.asset.findUniqueOrThrow({ where: { slug: SLUG } });
    const user = await prisma.user.findUniqueOrThrow({ where: { email: "page@example.com" } });

    await prisma.comment.create({
      data: {
        assetId: asset.id,
        userId: user.id,
        body: "<script>alert(1)</script>",
        status: "VISIBLE",
      },
    });

    const html = renderToStaticMarkup(
      await SkillDetailPage({ params: Promise.resolve({ slug: SLUG }) }),
    );

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("运营入口页面存在", () => {
  it("抽查页给出入口", async () => {
    const html = renderToStaticMarkup(await OpsCommentsPage());
    expect(html).toContain("运营抽查");
  });

  it("举报页给出入口", async () => {
    const html = renderToStaticMarkup(await OpsReportsPage());
    expect(html).toContain("举报");
  });
});
