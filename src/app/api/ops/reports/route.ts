/**
 * GET  /api/ops/reports —— 举报列表（默认只看待处理）。
 * PATCH /api/ops/reports —— 处理一条举报（成立 / 驳回）。
 *
 * 运营入口，角色闸门在 `resolveOperator`。
 */
import { NextResponse } from "next/server";

import { resolveOperator } from "@/lib/ops";
import { listReports, resolveReport } from "@/lib/reports";
import type { ReportStatus } from "@prisma/client";

// 运营入口要实时读库，不许被静态化。
export const dynamic = "force-dynamic";

/** 运营看到的举报列表。 */
export async function GET(request: Request): Promise<Response> {
  const resolved = await resolveOperator(request);
  if (!resolved.ok) {
    return resolved.response;
  }

  const statusParam = new URL(request.url).searchParams.get("status");

  // 默认只看待处理（OPEN）；`status=all` 看全部；否则按指定状态过滤。
  const status: ReportStatus | undefined =
    statusParam === null ? "OPEN" : statusParam === "all" ? undefined : (statusParam as ReportStatus);

  const items = await listReports({ status });

  return NextResponse.json({ items });
}

/** 处理一条举报：成立（隐藏内容）/ 驳回（保持可见）。 */
export async function PATCH(request: Request): Promise<Response> {
  const resolved = await resolveOperator(request);
  if (!resolved.ok) {
    return resolved.response;
  }

  let payload: { reportId?: unknown; action?: unknown };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "请求体不是合法的 JSON。" },
      { status: 400 },
    );
  }

  const reportId = typeof payload.reportId === "string" ? payload.reportId : "";
  const action = payload.action === "resolve" ? "resolve" : payload.action === "dismiss" ? "dismiss" : null;

  if (!reportId || !action) {
    return NextResponse.json(
      { error: "invalid_request", message: "缺少举报 id 或处理动作。" },
      { status: 400 },
    );
  }

  const outcome = await resolveReport(reportId, action === "resolve" ? "RESOLVED" : "DISMISSED");

  if (!outcome.ok) {
    return NextResponse.json({ error: "not_found", message: outcome.message }, { status: 404 });
  }

  return NextResponse.json({ ok: true, message: outcome.message });
}
