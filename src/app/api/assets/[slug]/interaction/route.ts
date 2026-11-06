import { NextResponse } from "next/server";

import { getAssetBySlug } from "@/lib/asset-query";
import { resolveInteractionActor } from "@/lib/interaction-actor";
import { actorInteractionState, interactionCounts } from "@/lib/interactions";

// 互动状态要实时读库，不许被静态化。
export const dynamic = "force-dynamic";

/**
 * GET /api/assets/{slug}/interaction —— 当前主体对某资产的互动状态与计数。
 *
 * 页面刷新后按钮的「已点赞 / 已收藏」状态靠它恢复（游客态靠设备指纹认人）。
 * 认不出主体时只返回计数，状态一律 false。
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;

  const asset = await getAssetBySlug(slug);
  if (!asset) {
    return NextResponse.json(
      { error: "not_found", message: "资产不存在。" },
      { status: 404 },
    );
  }

  const counts = await interactionCounts(asset.id);

  const resolved = await resolveInteractionActor(request);
  if (!resolved.ok) {
    return NextResponse.json({
      slug: asset.slug,
      assetId: asset.id,
      liked: false,
      likeCount: counts.likeCount,
      favorited: false,
      favoriteCount: counts.favoriteCount,
    });
  }

  const state = await actorInteractionState(asset.id, resolved.actor);

  return NextResponse.json({
    slug: asset.slug,
    assetId: asset.id,
    liked: state.liked,
    likeCount: counts.likeCount,
    favorited: state.favorited,
    favoriteCount: counts.favoriteCount,
  });
}
