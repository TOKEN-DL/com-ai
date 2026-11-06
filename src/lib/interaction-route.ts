/**
 * 互动路由（点赞 / 收藏）的共用处理流程。
 *
 * 三类资产共用一条路径：互动挂在 Asset 上，不按 kind 分表
 * （spec 决策 3）。所以路由挂在 `/api/assets/[slug]/...` 下，
 * 而不是 `/api/skills/...` —— MCP 与 Prompt 以后接上时不用再开一套。
 *
 * 三种结局都有**用户可见**的说法：
 *   - 资产不存在 → 404；
 *   - 认不出主体（没带设备标识）→ 400 + 提示；
 *   - 触发限流 → 429 + 提示（绝不静默丢弃）。
 */
import { NextResponse } from "next/server";

import { getAssetBySlug } from "@/lib/asset-query";
import { resolveInteractionActor } from "@/lib/interaction-actor";
import {
  actorInteractionState,
  favoriteAsset,
  InteractionRateLimitError,
  interactionCounts,
  likeAsset,
  unfavoriteAsset,
  unlikeAsset,
} from "@/lib/interactions";

export type InteractionKind = "like" | "favorite";

/**
 * 处理一次点赞 / 收藏请求。
 *
 * @param kind  互动种类。
 * @param action `set` = 点赞 / 收藏；`clear` = 取消。
 */
export async function handleInteractionRoute(
  request: Request,
  slug: string,
  kind: InteractionKind,
  action: "set" | "clear",
): Promise<Response> {
  const asset = await getAssetBySlug(slug);
  if (!asset) {
    return NextResponse.json(
      { error: "not_found", message: "资产不存在。" },
      { status: 404 },
    );
  }

  const resolved = await resolveInteractionActor(request);
  if (!resolved.ok) {
    return NextResponse.json(
      { error: resolved.error, message: resolved.message },
      { status: resolved.status },
    );
  }

  try {
    if (kind === "like") {
      if (action === "set") {
        await likeAsset(asset.id, resolved.actor);
      } else {
        await unlikeAsset(asset.id, resolved.actor);
      }
    } else if (action === "set") {
      await favoriteAsset(asset.id, resolved.actor);
    } else {
      await unfavoriteAsset(asset.id, resolved.actor);
    }
  } catch (error) {
    if (error instanceof InteractionRateLimitError) {
      return NextResponse.json(
        {
          error: "rate_limited",
          message: "操作太频繁了，请稍后再试。",
          retryAfterSeconds: error.retryAfterSeconds,
        },
        { status: 429, headers: { "Retry-After": String(error.retryAfterSeconds) } },
      );
    }
    throw error;
  }

  const [counts, state] = await Promise.all([
    interactionCounts(asset.id),
    actorInteractionState(asset.id, resolved.actor),
  ]);

  return NextResponse.json({
    slug: asset.slug,
    assetId: asset.id,
    liked: state.liked,
    likeCount: counts.likeCount,
    favorited: state.favorited,
    favoriteCount: counts.favoriteCount,
  });
}
