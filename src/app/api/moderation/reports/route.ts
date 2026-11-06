import { NextResponse } from "next/server";
import type { ReportStatus } from "@prisma/client";

import { listReports } from "@/lib/publish-moderation";
import { requireModerator } from "@/lib/publish-gate";

// 要实时读库，不许被静态化。
export const dynamic = "force-dynamic";

/**
 * GET /api/moderation/reports —— 待处理的举报列表（运营抽查用）。
 *
 * 默认只返回 OPEN（未处理）的举报。
 */
export async function GET(request: Request): Promise<Response> {
  const gate = await requireModerator(request);
  if (!gate.ok) {
    return gate.response;
  }

  const url = new URL(request.url);
  const rawStatus = url.searchParams.get("status");
  const status =
    rawStatus === "OPEN" || rawStatus === "RESOLVED" || rawStatus === "DISMISSED"
      ? (rawStatus as ReportStatus)
      : "OPEN";

  const items = await listReports({ status });
  return NextResponse.json({ items });
}
