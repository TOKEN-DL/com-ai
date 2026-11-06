import { NextResponse } from "next/server";

import { reviewPublication } from "@/lib/publish-moderation";
import { requireModerator } from "@/lib/publish-gate";

// 要实时写库，不许被静态化。
export const dynamic = "force-dynamic";

/**
 * POST /api/moderation/published/{id} —— 审核一条发布记录。
 *
 * body: `{ action: "approve" | "reject", note?: string }`
 *
 * - `approve`（放行 / 改判）：状态 → PUBLISHED，资产重新对外可见；
 * - `reject`（驳回 / 下架）：状态 → REJECTED，**必须写审核意见**。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const gate = await requireModerator(request);
  if (!gate.ok) {
    return gate.response;
  }

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "请求体不是合法的 JSON。" },
      { status: 400 },
    );
  }

  const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const action = record.action === "approve" ? "approve" : record.action === "reject" ? "reject" : null;

  if (!action) {
    return NextResponse.json(
      { error: "invalid_input", message: "action 只能是 approve 或 reject。" },
      { status: 400 },
    );
  }

  const result = await reviewPublication({
    publicationId: id,
    action,
    note: typeof record.note === "string" ? record.note : null,
    reviewerId: gate.moderator.userId,
  });

  if (!result.ok) {
    if (result.error === "not_found") {
      return NextResponse.json(
        { error: "not_found", message: "没有找到这条发布记录。" },
        { status: 404 },
      );
    }
    return NextResponse.json(
      { error: "invalid_note", message: "驳回时必须写审核意见 —— 发布者有权知道原因。" },
      { status: 400 },
    );
  }

  return NextResponse.json({ ok: true, item: result.view });
}
