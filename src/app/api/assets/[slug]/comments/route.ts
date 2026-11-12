/**
 * GET /api/assets/{slug}/comments —— 评论列表（公开）。
 * POST /api/assets/{slug}/comments —— 发表评论 / 回复（**必须登录**）。
 *
 * 路由挂在 `/api/assets/...` 而不是 `/api/skills/...`：评论挂在 Asset 上，
 * 三类资产共用一条路径（与收藏点赞同一条道理，spec 决策 3）。
 */
import { NextResponse } from "next/server";

import { getAssetBySlug } from "@/lib/asset-query";
import { createComment, listAssetComments } from "@/lib/comments";
import { resolveScenarioSource } from "@/lib/scenario-service";
import { getSessionUser, unauthorizedResponse } from "@/lib/session";

// 评论要实时读库，不许被静态化。
export const dynamic = "force-dynamic";

/**
 * 评论要挂在哪个资产上。
 *
 * 场景卡片（票 #12）的评论**挂在源 Skill 上** —— 卡片详情页与 Skill 详情页
 * 共用同一套评论数据。用卡片的 slug 发评论时也要落到源资产上，
 * 否则站上就出现两套评论：同一个 Skill 的经验散在两处。
 */
async function resolveCommentTarget(
  slug: string,
): Promise<{ id: string; slug: string } | null> {
  const asset = await getAssetBySlug(slug);
  if (!asset) {
    return null;
  }

  if (asset.kind === "SCENARIO") {
    return resolveScenarioSource(asset.id);
  }

  return { id: asset.id, slug: asset.slug };
}

/** 列出某个资产下的评论（顶层评论 + 挂在下面的回复）。 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;
  const target = await resolveCommentTarget(slug);

  if (!target) {
    return NextResponse.json({ error: "not_found", message: "资产不存在。" }, { status: 404 });
  }

  const items = await listAssetComments(target.id);

  return NextResponse.json({ slug, targetSlug: target.slug, items });
}

/** 发表评论（顶层）或回复（带 parentId）。 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;

  // 评论必须登录：责任归属（spec 决策 10）。
  const session = await getSessionUser(request);
  if (!session) {
    return unauthorizedResponse("登录后才能发表评论。");
  }

  const target = await resolveCommentTarget(slug);

  if (!target) {
    return NextResponse.json({ error: "not_found", message: "资产不存在。" }, { status: 404 });
  }

  let payload: { body?: unknown; parentId?: unknown };
  try {
    payload = (await request.json()) as { body?: unknown; parentId?: unknown };
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "请求体不是合法的 JSON。" },
      { status: 400 },
    );
  }

  const body = typeof payload.body === "string" ? payload.body : "";
  const parentId =
    typeof payload.parentId === "string" && payload.parentId.length > 0 ? payload.parentId : null;

  const outcome = await createComment({
    assetId: target.id,
    userId: session.id,
    body,
    parentId,
  });

  if (!outcome.ok) {
    return NextResponse.json(
      { error: outcome.error, message: outcome.message },
      { status: outcome.status },
    );
  }

  // 命中自动关键词过滤：拦下，不公开。
  // ⚠️ 不告诉用户命中了哪个词 —— 说了等于教他怎么绕过去。
  if (outcome.status === "PENDING") {
    return NextResponse.json(
      {
        error: "content_filtered",
        message: "评论包含不允许的内容（命中关键词过滤），未能发布。请修改后重试。",
      },
      { status: 422 },
    );
  }

  return NextResponse.json({ comment: outcome.comment }, { status: 201 });
}
