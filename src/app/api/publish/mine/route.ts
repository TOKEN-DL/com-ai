import { NextResponse } from "next/server";

import { listMyPublications } from "@/lib/publish-moderation";
import { requireVerifiedPublisher } from "@/lib/publish-gate";

// 要实时读库，不许被静态化。
export const dynamic = "force-dynamic";

/**
 * GET /api/publish/mine —— 「我的发布」列表。
 *
 * 只返回**自己**的发布记录，每条带上审核状态与审核意见
 * （发布者有权知道自己的东西为什么被下架）。
 */
export async function GET(request: Request): Promise<Response> {
  const gate = await requireVerifiedPublisher(request);
  if (!gate.ok) {
    return gate.response;
  }

  const items = await listMyPublications(gate.userId);
  return NextResponse.json({ items });
}
