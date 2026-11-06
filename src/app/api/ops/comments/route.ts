/**
 * GET   /api/ops/comments —— 按时间浏览近期评论（运营抽查）。
 * PATCH /api/ops/comments —— 改一条评论的审核状态。
 *
 * 抽查是「运营不定期巡查」，**不是全量预审队列**（spec 决策 11）：
 * 单人运营下后者会立刻成为瓶颈。所以这里只是按时间倒序拉一段出来给人看，
 * 默认只给最近 7 天。
 */
import { NextResponse } from "next/server";

import { listRecentComments, setCommentStatus } from "@/lib/comments";
import { resolveOperator } from "@/lib/ops";
import type { CommentStatus } from "@prisma/client";

// 运营入口要实时读库，不许被静态化。
export const dynamic = "force-dynamic";

/** 运营抽查：近期评论。 */
export async function GET(request: Request): Promise<Response> {
  const resolved = await resolveOperator(request);
  if (!resolved.ok) {
    return resolved.response;
  }

  const search = new URL(request.url).searchParams;

  const daysParam = Number.parseInt(search.get("days") ?? "7", 10);
  const days = Number.isFinite(daysParam) && daysParam > 0 ? daysParam : 7;

  const statusParam = search.get("status");
  const status: CommentStatus | undefined =
    statusParam && statusParam !== "all" ? (statusParam as CommentStatus) : undefined;

  const items = await listRecentComments({ days, status });

  return NextResponse.json({ items, days });
}

/** 改一条评论的审核状态：放行 / 隐藏 / 恢复。 */
export async function PATCH(request: Request): Promise<Response> {
  const resolved = await resolveOperator(request);
  if (!resolved.ok) {
    return resolved.response;
  }

  let payload: { commentId?: unknown; action?: unknown };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "请求体不是合法的 JSON。" },
      { status: 400 },
    );
  }

  const commentId = typeof payload.commentId === "string" ? payload.commentId : "";

  // 动作 → 目标状态。放行 = 抽查通过；隐藏 = 举报成立 / 运营处理；恢复 = 重新公开。
  const target: CommentStatus | null =
    payload.action === "approve"
      ? "VISIBLE"
      : payload.action === "hide"
        ? "HIDDEN"
        : payload.action === "restore"
          ? "VISIBLE"
          : null;

  if (!commentId || !target) {
    return NextResponse.json(
      { error: "invalid_request", message: "缺少评论 id 或处理动作。" },
      { status: 400 },
    );
  }

  const outcome = await setCommentStatus(commentId, target);

  if (!outcome.ok) {
    return NextResponse.json({ error: "not_found", message: outcome.message }, { status: 404 });
  }

  return NextResponse.json({ ok: true, message: outcome.message, status: target });
}
