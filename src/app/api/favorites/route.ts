import { NextResponse } from "next/server";

import { toAssetListItem } from "@/lib/asset-item";
import { listFavoritedAssets } from "@/lib/interactions";
import { getSessionUser, unauthorizedResponse } from "@/lib/session";
import { listFavoritedUpdateFlags } from "@/lib/version-store";

// 要实时读库，不许被静态化。
export const dynamic = "force-dynamic";

/**
 * GET /api/favorites —— 登录态的「我的收藏」。
 *
 * 游客态不走这里：游客的收藏清单在浏览器本地（localStorage），
 * 由页面直接读 —— 服务端不替游客保管清单。
 *
 * 收藏的资产出了新版本时，这里带上「有新版本」标记（票 #16）：
 * 登录用户因此有一个**订阅式**的提示入口，不必逐个点进详情页。
 */
export async function GET(request: Request): Promise<Response> {
  const session = await getSessionUser(request);
  if (!session) {
    return unauthorizedResponse("请先登录后查看收藏。");
  }

  const assets = await listFavoritedAssets({ userId: session.id });
  const flags = await listFavoritedUpdateFlags(
    assets.map((asset) => asset.id),
    { userId: session.id },
  );

  return NextResponse.json({
    items: assets.map((asset) => {
      const flag = flags.get(asset.id);
      return {
        ...toAssetListItem(asset),
        hasUpdate: flag?.hasUpdate ?? false,
        latestVersion: flag?.latestVersion ?? null,
      };
    }),
  });
}
