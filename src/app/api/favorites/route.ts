import { NextResponse } from "next/server";

import { toAssetListItem } from "@/lib/asset-item";
import { listFavoritedAssets } from "@/lib/interactions";
import { getSessionUser, unauthorizedResponse } from "@/lib/session";

// 要实时读库，不许被静态化。
export const dynamic = "force-dynamic";

/**
 * GET /api/favorites —— 登录态的「我的收藏」。
 *
 * 游客态不走这里：游客的收藏清单在浏览器本地（localStorage），
 * 由页面直接读 —— 服务端不替游客保管清单。
 */
export async function GET(request: Request): Promise<Response> {
  const session = await getSessionUser(request);
  if (!session) {
    return unauthorizedResponse("请先登录后查看收藏。");
  }

  const assets = await listFavoritedAssets({ userId: session.id });

  return NextResponse.json({ items: assets.map(toAssetListItem) });
}
