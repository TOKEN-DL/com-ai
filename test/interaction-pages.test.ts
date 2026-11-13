/**
 * 页面渲染：互动计数真的出现在详情页与列表页上。
 *
 * 这一条只在 HTTP 边界上测不到 —— 页面把计数渲染成什么样，
 * 得看渲染出来的 HTML。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import FavoritesPage from "@/app/favorites/page";
import SkillDetailPage from "@/app/skills/[slug]/page";
import SkillListPage from "@/app/skills/page";
import { prisma } from "@/lib/prisma";

/** 建一个带互动计数的 Skill：7 个收藏、9 个点赞（计数由触发器维护）。 */
async function seedSkillWithInteractions(slug: string): Promise<void> {
  const asset = await prisma.asset.create({
    data: { kind: "SKILL", slug, displayName: `页面 Skill ${slug}`, license: "MIT" },
  });

  await prisma.favorite.createMany({
    data: Array.from({ length: 7 }, (_, index) => ({
      assetId: asset.id,
      actorKey: `device:fav-${index}`,
      deviceId: `fav-${index}`,
    })),
  });

  await prisma.like.createMany({
    data: Array.from({ length: 9 }, (_, index) => ({
      assetId: asset.id,
      actorKey: `device:like-${index}`,
      deviceId: `like-${index}`,
    })),
  });
}

describe("详情页与列表页展示互动计数", () => {
  it("详情页显示收藏数与点赞数", async () => {
    await seedSkillWithInteractions("page-detail-skill");

    const html = renderToStaticMarkup(
      await SkillDetailPage({ params: Promise.resolve({ slug: "page-detail-skill" }) }),
    );

    expect(html).toContain("收藏 7");
    expect(html).toContain("点赞 9");
  });

  it("列表页显示收藏数与点赞数", async () => {
    await seedSkillWithInteractions("page-list-skill");

    const html = renderToStaticMarkup(await SkillListPage({ searchParams: Promise.resolve({}) }));

    expect(html).toContain("收藏 7");
    expect(html).toContain("点赞 9");
  });

  it("「我的收藏」页存在并给出入口", async () => {
    const html = renderToStaticMarkup(await FavoritesPage());

    expect(html).toContain("我的收藏");
  });
});
