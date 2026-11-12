import { NextResponse } from "next/server";

import { getMcpDetail } from "@/lib/mcp-detail";

// 详情要实时读库，不许被静态化。
export const dynamic = "force-dynamic";

/**
 * GET /api/mcp/{slug} —— MCP 详情。
 *
 * 返回的就是页面用的那份视图模型（含工具定义、环境变量、配置片段），
 * 所以「页面上显示的」与「接口返回的」逐字一致 ——
 * 一键复制拿到的就是接口里那份 `configText`。
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;
  const mcp = await getMcpDetail(slug);

  if (!mcp) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return NextResponse.json(mcp);
}
