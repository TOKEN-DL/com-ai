/**
 * POST /api/reports —— 提交举报。
 *
 * 审核链路（spec 决策 11）的第二环：**用户举报**。
 * 任何人（登录或游客）都能举报违规内容 —— 举报的门槛必须比评论低，
 * 否则「遇到垃圾内容想举报却要先注册」就没人举报了。
 *
 * 举报只落库，**不直接删内容**：处理与否由运营决定（见 /api/ops/reports）。
 */
import { NextResponse } from "next/server";

import { getAssetBySlug } from "@/lib/asset-query";
import { createReport, isReportReason } from "@/lib/reports";
import { getSessionUser } from "@/lib/session";

// 举报要实时读库，不许被静态化。
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let payload: {
    target?: unknown;
    commentId?: unknown;
    slug?: unknown;
    assetId?: unknown;
    reason?: unknown;
    detail?: unknown;
  };

  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "请求体不是合法的 JSON。" },
      { status: 400 },
    );
  }

  if (payload.target !== "COMMENT" && payload.target !== "ASSET") {
    return NextResponse.json(
      { error: "invalid_target", message: "举报对象只能是评论或资产。" },
      { status: 400 },
    );
  }

  if (!isReportReason(payload.reason)) {
    return NextResponse.json(
      { error: "invalid_reason", message: "举报理由不合法。" },
      { status: 400 },
    );
  }

  // 举报人不必登录：登录了就记下是谁，游客态留空。
  const session = await getSessionUser(request);
  const reporterUserId = session?.id ?? null;

  let commentId: string | null = null;
  let assetId: string | null = null;

  if (payload.target === "COMMENT") {
    commentId = typeof payload.commentId === "string" ? payload.commentId : null;
  } else if (typeof payload.slug === "string" && payload.slug.length > 0) {
    const asset = await getAssetBySlug(payload.slug);

    // slug 给了但查不到 → 404（与「举报一条不存在的评论」同一个口径）。
    if (!asset) {
      return NextResponse.json(
        { error: "asset_not_found", message: "要举报的资产不存在。" },
        { status: 404 },
      );
    }

    assetId = asset.id;
  } else if (typeof payload.assetId === "string" && payload.assetId.length > 0) {
    assetId = payload.assetId;
  }

  const outcome = await createReport({
    target: payload.target,
    commentId,
    assetId,
    reason: payload.reason,
    detail: typeof payload.detail === "string" ? payload.detail : null,
    reporterUserId,
  });

  if (!outcome.ok) {
    return NextResponse.json(
      { error: outcome.error, message: outcome.message },
      { status: outcome.status },
    );
  }

  return NextResponse.json(
    { report: outcome.report, duplicate: outcome.duplicate },
    { status: outcome.duplicate ? 200 : 201 },
  );
}
