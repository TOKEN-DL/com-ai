import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { overrideAssetSummary } from "@/lib/summary-service";
import { getSessionUser, unauthorizedResponse } from "@/lib/session";

// 要实时写库，不许被静态化。
export const dynamic = "force-dynamic";

/** 简介正文的上限。 */
const MAX_SUMMARY_LENGTH = 2000;
/** 「何时用 / 怎么用」的上限。 */
const MAX_USAGE_LENGTH = 1000;

/**
 * PATCH /api/assets/{slug}/summary —— 人工覆盖中文简介（票 #7）。
 *
 * body: `{ summaryZh: string, whenToUse?: string | null, howToUse?: string | null }`
 *
 * ## 谁能覆盖
 *
 * **资产作者**与**运营**（MODERATOR / ADMIN，与 publish-gate 的判定同一条口径）。
 * 其它登录用户一律 403 —— 简介是站点对这段资产的公开描述，
 * 不能谁都能改。
 *
 * ## 覆盖之后
 *
 *   - `summarySource` 变成 `HUMAN`，页面显示「人工撰写」；
 *   - 记下覆盖时间与覆盖人；
 *   - **之后的批量重跑会跳过这条** —— 人工纠正过的东西不该被机器改回去。
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const session = await getSessionUser(request);
  if (!session) {
    return unauthorizedResponse("改写简介需要先登录。");
  }

  const { slug } = await params;

  const asset = await prisma.asset.findUnique({
    where: { slug },
    select: {
      id: true,
      publishedBy: { select: { userId: true } },
    },
  });

  if (!asset) {
    return NextResponse.json(
      { error: "not_found", message: "没有找到这个资产。" },
      { status: 404 },
    );
  }

  // 资产作者 = 在这个资产下留过发布记录的用户。
  const isAuthor = asset.publishedBy.some((row) => row.userId === session.id);
  const isOperator = session.role === "MODERATOR" || session.role === "ADMIN";

  if (!isAuthor && !isOperator) {
    return NextResponse.json(
      { error: "forbidden", message: "只有资产作者或运营可以改写简介。" },
      { status: 403 },
    );
  }

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

  const summaryZh = typeof record.summaryZh === "string" ? record.summaryZh.trim() : "";
  if (summaryZh.length === 0) {
    return NextResponse.json(
      { error: "invalid_input", message: "简介不能为空。" },
      { status: 400 },
    );
  }
  if (summaryZh.length > MAX_SUMMARY_LENGTH) {
    return NextResponse.json(
      { error: "invalid_input", message: `简介太长了（${MAX_SUMMARY_LENGTH} 字以内）。` },
      { status: 400 },
    );
  }

  const whenToUse = readOptionalText(record.whenToUse, MAX_USAGE_LENGTH);
  if (whenToUse === undefined) {
    return NextResponse.json(
      { error: "invalid_input", message: `「何时用」太长了（${MAX_USAGE_LENGTH} 字以内）。` },
      { status: 400 },
    );
  }

  const howToUse = readOptionalText(record.howToUse, MAX_USAGE_LENGTH);
  if (howToUse === undefined) {
    return NextResponse.json(
      { error: "invalid_input", message: `「怎么用」太长了（${MAX_USAGE_LENGTH} 字以内）。` },
      { status: 400 },
    );
  }

  const result = await overrideAssetSummary({
    assetId: asset.id,
    summaryZh,
    whenToUse,
    howToUse,
    operatorId: session.id,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: "not_found", message: "没有找到这个资产。" },
      { status: 404 },
    );
  }

  const updated = await prisma.asset.findUniqueOrThrow({
    where: { id: asset.id },
    select: {
      slug: true,
      summaryZh: true,
      summarySource: true,
      whenToUse: true,
      howToUse: true,
      summaryOverriddenAt: true,
    },
  });

  return NextResponse.json({ ok: true, item: updated });
}

/**
 * 读一个可选文本字段。
 *
 * - 缺省 / null → null（清空这一栏）；
 * - 字符串 → 去掉首尾空白；
 * - 超长 → undefined（调用方据此报 400）。
 */
function readOptionalText(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    return undefined;
  }
  return trimmed;
}
