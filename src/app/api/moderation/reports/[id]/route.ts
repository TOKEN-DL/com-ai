import { NextResponse } from "next/server";

import { resolveReport } from "@/lib/publish-moderation";
import { requireModerator } from "@/lib/publish-gate";

// 要实时写库，不许被静态化。
export const dynamic = "force-dynamic";

/**
 * POST /api/moderation/reports/{id} —— 处理一条举报。
 *
 * body: `{ action: "resolve" | "dismiss", note?: string }`
 *
 * - `resolve`（举报成立）：举报关闭，资产下架 → 状态 REJECTED；
 * - `dismiss`（举报不成立）：举报关闭；若已无其它未处理举报，资产恢复展示。
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
  const action = record.action === "resolve" ? "resolve" : record.action === "dismiss" ? "dismiss" : null;

  if (!action) {
    return NextResponse.json(
      { error: "invalid_input", message: "action 只能是 resolve 或 dismiss。" },
      { status: 400 },
    );
  }

  const result = await resolveReport({
    reportId: id,
    action,
    note: typeof record.note === "string" ? record.note : null,
    reviewerId: gate.moderator.userId,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: "not_found", message: "没有找到这条举报。" },
      { status: 404 },
    );
  }

  return NextResponse.json({ ok: true, item: result.view, publicationStatus: result.publicationStatus });
}
