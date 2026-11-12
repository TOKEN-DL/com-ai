import { NextResponse } from "next/server";

import { getSkillDetail } from "@/lib/asset-detail";

// 详情要实时读库，不许被静态化。
export const dynamic = "force-dynamic";

/**
 * GET /api/skills/{slug} —— Skill 详情。
 *
 * 返回的就是页面用的那份视图模型（含安装命令与 SKILL.md 全文），
 * 所以「页面上显示的」与「接口返回的」逐字一致。
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;
  const skill = await getSkillDetail(slug);

  if (!skill) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return NextResponse.json(skill);
}
