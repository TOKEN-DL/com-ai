import { NextResponse } from "next/server";
import type { ReportReason } from "@prisma/client";

import { getSessionUser } from "@/lib/session";
import { reportPublishedAsset } from "@/lib/publish-moderation";

// 要实时写库，不许被静态化。
export const dynamic = "force-dynamic";

/**
 * POST /api/publish/report —— 举报一个资产。
 *
 * **游客也能举报**（spec 约束 7：注册墙只出现在「发布自己的资产」与
 * 「跨设备同步安装清单」两处）。举报理由必须是受支持的枚举值。
 *
 * 命中后：用户发布的资产立即下架（状态 → PENDING）等运营抽查；
 * 已被采集收录的资产不在本票的处理范围，这里只落举报记录。
 */
export async function POST(request: Request): Promise<Response> {
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
  const assetSlug = typeof record.assetSlug === "string" ? record.assetSlug.trim() : "";
  const reason = (typeof record.reason === "string" ? record.reason.trim().toUpperCase() : "") as ReportReason;

  if (assetSlug.length === 0) {
    return NextResponse.json(
      { error: "invalid_input", message: "缺少要举报的资产。" },
      { status: 400 },
    );
  }

  const session = await getSessionUser(request);

  const result = await reportPublishedAsset({
    assetSlug,
    reason,
    detail: typeof record.detail === "string" ? record.detail : null,
    reporterUserId: session?.id ?? null,
  });

  if (!result.ok) {
    if (result.error === "not_found") {
      return NextResponse.json(
        { error: "not_found", message: "没有找到这个资产。" },
        { status: 404 },
      );
    }
    return NextResponse.json(
      { error: "invalid_reason", message: "举报理由不受支持。" },
      { status: 400 },
    );
  }

  return NextResponse.json(
    {
      ok: true,
      reportId: result.reportId,
      message: "举报已提交，我们会尽快处理。",
    },
    { status: 201 },
  );
}
