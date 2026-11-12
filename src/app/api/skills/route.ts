import { NextResponse } from "next/server";

import { toAssetListItem } from "@/lib/asset-item";
import { listAssets } from "@/lib/asset-query";

// 列表要实时读库，不许被静态化。
export const dynamic = "force-dynamic";

/**
 * GET /api/skills —— Skill 列表。
 *
 * 关键词检索是 #5 的 `SearchService` 的事，这里只按热度 / 时间排序取列表。
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") ?? "50");
  const order = url.searchParams.get("order");

  const assets = await listAssets({
    kind: "SKILL",
    limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 50,
    orderBy: order === "recent" || order === "installs" ? order : "heat",
  });

  return NextResponse.json({
    items: assets.map(toAssetListItem),
  });
}
