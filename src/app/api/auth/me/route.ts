/**
 * GET /api/auth/me —— 当前是谁。
 *
 * 页面用它来反映登录态（导航上的「登录 / 登出」）。
 * **只回显用户自己**：邮箱、显示名、角色。没有会话就是游客态。
 */
import { NextResponse } from "next/server";

import { getSessionUser } from "@/lib/session";

// 要实时读库，不许被静态化。
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const session = await getSessionUser(request);

  if (!session) {
    return NextResponse.json({ authenticated: false, user: null });
  }

  return NextResponse.json({
    authenticated: true,
    user: {
      id: session.id,
      email: session.email,
      displayName: session.displayName,
      role: session.role,
    },
  });
}
