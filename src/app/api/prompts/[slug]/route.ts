import { NextResponse } from "next/server";

import { getPromptDetail } from "@/lib/prompt-detail";

// 详情要实时读库，不许被静态化。
export const dynamic = "force-dynamic";

/**
 * GET /api/prompts/{slug} —— Prompt 详情。
 *
 * 返回的就是页面用的那份视图模型（含逐字原文 `promptBody` 与一键复制用的
 * `copyText`），所以「页面上显示的」与「接口返回的」逐字一致 ——
 * 一键复制拿到的就是接口里那份 `copyText`。
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;
  const prompt = await getPromptDetail(slug);

  if (!prompt) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return NextResponse.json(prompt);
}
