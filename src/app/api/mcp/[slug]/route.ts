import { NextResponse } from "next/server";

import { getMcpDetail } from "@/lib/mcp-detail";
import { getSessionUser } from "@/lib/session";

// 详情要实时读库，不许被静态化。
export const dynamic = "force-dynamic";

/**
 * GET /api/mcp/{slug} —— MCP 详情。
 *
 * 返回的就是页面用的那份视图模型（含工具定义、环境变量、配置片段），
 * 所以「页面上显示的」与「接口返回的」逐字一致 ——
 * 一键复制拿到的就是接口里那份 `configText`。
 *
 * 冲突项（票 #14）同理：登录用户会带上与已接入集合的冲突，
 * 游客态返回空数组 —— 与页面口径一致。
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;

  // 冲突检测要看「这个用户已接入了哪些 server」—— 只有登录用户才有。
  const session = await getSessionUser(request);
  const mcp = await getMcpDetail(slug, { userId: session?.id ?? null });

  if (!mcp) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return NextResponse.json(mcp);
}
