import { NextResponse } from "next/server";

import { getAssetBySlug } from "@/lib/asset-query";
import { resolveInteractionActor } from "@/lib/interaction-actor";
import { getUpdateStatus, listVersions, toVersionView } from "@/lib/version-store";

// 版本要实时读库，不许被静态化。
export const dynamic = "force-dynamic";

/**
 * GET /api/assets/{slug}/versions —— 版本历史 + 更新提示。
 *
 * ## 更新提示的语义
 *
 * 「你收藏之后，上游（或发布者）又出了新版本」。
 * 判定依据是时间比较：`AssetVersion.createdAt > Favorite.createdAt`。
 *
 * ## 游客态同样成立
 *
 * 收藏行按设备指纹落库（`actorKey = device:<hash>`），客户端带上 `x-device-id`
 * 就能认出自己的收藏行 —— 游客没有账号，但**提示照样成立**。
 * 认不出主体（既没登录也没有设备指纹）时返回 `hasUpdate: false`，不是错误。
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;
  const asset = await getAssetBySlug(slug);

  if (!asset) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const versions = (await listVersions(asset.id)).map(toVersionView);

  const actor = await resolveInteractionActor(request);
  const update = actor.ok
    ? await getUpdateStatus(asset.id, actor.actor)
    : {
        favorited: false,
        hasUpdate: false,
        latestVersion: versions[0] ?? null,
        seenVersion: null,
      };

  return NextResponse.json({ versions, update });
}
