import { NextResponse } from "next/server";
import type { PublishStatus } from "@prisma/client";

import { listPublicationsForReview } from "@/lib/publish-moderation";
import { requireModerator } from "@/lib/publish-gate";

// 要实时读库，不许被静态化。
export const dynamic = "force-dynamic";

/**
 * GET /api/moderation/published —— 运营抽查列表。
 *
 * 默认只看待处理的（PENDING）；不带 status 时返回全部。
 * 抽查是「有空就翻翻」，不是每天必须清空一个队列。
 */
export async function GET(request: Request): Promise<Response> {
  const gate = await requireModerator(request);
  if (!gate.ok) {
    return gate.response;
  }

  const url = new URL(request.url);
  const rawStatus = url.searchParams.get("status");
  const status =
    rawStatus === "PENDING" || rawStatus === "PUBLISHED" || rawStatus === "REJECTED"
      ? (rawStatus as PublishStatus)
      : undefined;

  const items = await listPublicationsForReview({ status, limit: 100 });
  return NextResponse.json({ items });
}
