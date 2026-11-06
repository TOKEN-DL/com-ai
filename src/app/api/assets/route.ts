import { NextResponse } from "next/server";

import { toAssetListItem } from "@/lib/asset-item";
import { prisma } from "@/lib/prisma";

// 要实时读库，不许被静态化。
export const dynamic = "force-dynamic";

/**
 * GET /api/assets?slugs=a,b,c —— 按 slug 批量取资产。
 *
 * 游客态的「我的收藏」清单存在浏览器里，页面拿本地 slug 列表来这里换详情。
 * 跨 kind（SKILL / MCP / PROMPT）都走这一条路径 —— 收藏挂在 Asset 上，
 * 不按 kind 分表（spec 决策 3）。
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const slugs = (url.searchParams.get("slugs") ?? "")
    .split(",")
    .map((slug) => slug.trim())
    .filter(Boolean);

  if (slugs.length === 0) {
    return NextResponse.json({ items: [] });
  }

  const assets = await prisma.asset.findMany({ where: { slug: { in: slugs } } });
  const bySlug = new Map(assets.map((asset) => [asset.slug, asset]));

  // 按请求里的顺序返回，页面上的顺序跟本地清单一致。
  const items = slugs
    .map((slug) => bySlug.get(slug))
    .filter((asset): asset is NonNullable<typeof asset> => asset !== undefined)
    .map(toAssetListItem);

  return NextResponse.json({ items });
}
