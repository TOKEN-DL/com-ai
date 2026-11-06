/**
 * POST /api/auth/logout —— 登出。
 *
 * 两件事一起做：
 *   1. 删掉 `Session` 行 —— **服务端真的失效**（不是只删 cookie）；
 *   2. 把会话 cookie 清掉（Max-Age=0）。
 *
 * 只删 cookie 是不够的：那枚 JWT 在过期前仍然有效，别人拿到就能用。
 */
import { NextResponse } from "next/server";

import { clearedSessionCookieHeader, readSessionCookie, revokeSession } from "@/lib/session";

// 要写库，不许被静态化。
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const token = readSessionCookie(request);

  if (token) {
    await revokeSession(token);
  }

  return NextResponse.json(
    { ok: true },
    { headers: { "set-cookie": clearedSessionCookieHeader() } },
  );
}
