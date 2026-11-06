/**
 * /api/auth/verify —— 校验一次性登录令牌，签发会话。
 *
 * 两种调用方式：
 *   - `POST`（JSON 或表单）：浏览器里的登录页用这个 —— **带上 `x-device-id` 请求头**，
 *     服务端才能把游客态的收藏 / 点赞合并到账号名下。
 *   - `GET ?token=`：直接访问链接（无 JS 也能登录，但没有设备指纹，合并不了游客态互动）。
 *
 * 无论哪种方式，令牌都**只能用一次**：用掉就作废，第二次来一律拒绝。
 */
import { LoginTokenPurpose } from "@prisma/client";
import { NextResponse } from "next/server";

import { completeLogin, findOrCreateUserByEmail } from "@/lib/auth-service";
import { authBaseUrl } from "@/lib/auth-config";
import { consumeLoginToken, type LoginTokenFailure } from "@/lib/login-tokens";
import { sessionCookieHeader } from "@/lib/session";

// 要实时读库 + 写会话，不许被静态化。
export const dynamic = "force-dynamic";

/** 令牌用不了时给用户看的说法。 */
const FAILURE_MESSAGES: Record<LoginTokenFailure, string> = {
  invalid: "登录链接无效，请重新申请一个。",
  expired: "登录链接已过期，请重新申请一个。",
  used: "这个登录链接已经用过了，请重新申请一个。",
};

/** 从请求里取令牌：支持 JSON 体与表单体。 */
async function readToken(request: Request): Promise<string> {
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    try {
      const body = (await request.json()) as { token?: unknown };
      return typeof body?.token === "string" ? body.token : "";
    } catch {
      return "";
    }
  }

  if (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  ) {
    try {
      const form = await request.formData();
      const value = form.get("token");
      return typeof value === "string" ? value : "";
    } catch {
      return "";
    }
  }

  return "";
}

/** 浏览器发来的表单提交要跳回页面；API 调用要 JSON。 */
function prefersHtml(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("text/html");
}

/** 校验令牌 → 建会话 → 返回结果。 */
async function verify(request: Request, token: string): Promise<Response> {
  const consumed = await consumeLoginToken(token, LoginTokenPurpose.EMAIL_MAGIC);

  if (!consumed.ok) {
    const message = FAILURE_MESSAGES[consumed.reason];

    if (prefersHtml(request)) {
      return NextResponse.redirect(`${authBaseUrl(new URL(request.url).origin)}/login?status=${consumed.reason}`);
    }

    return NextResponse.json({ error: consumed.reason, message }, { status: 400 });
  }

  const user = await findOrCreateUserByEmail(consumed.email ?? "");
  const { session, merged } = await completeLogin({ userId: user.id, request });

  const cookie = sessionCookieHeader(session.token, session.expiresAt);

  if (prefersHtml(request)) {
    const target = new URL(`${authBaseUrl(new URL(request.url).origin)}/login`);
    target.searchParams.set("status", "ok");
    target.searchParams.set("mergedFavorites", String(merged.favorites));
    target.searchParams.set("mergedLikes", String(merged.likes));
    target.searchParams.set("mergedFavoritesDeduplicated", String(merged.favoritesDeduplicated));
    target.searchParams.set("mergedLikesDeduplicated", String(merged.likesDeduplicated));

    return NextResponse.redirect(target.toString(), { headers: { "set-cookie": cookie } });
  }

  return NextResponse.json(
    {
      ok: true,
      user: { id: user.id, email: user.email, displayName: user.displayName },
      merged: {
        favorites: merged.favorites,
        likes: merged.likes,
        favoritesDeduplicated: merged.favoritesDeduplicated,
        likesDeduplicated: merged.likesDeduplicated,
      },
    },
    { headers: { "set-cookie": cookie } },
  );
}

/** POST：登录页用这个（带 `x-device-id` 请求头，能合并游客态互动）。 */
export async function POST(request: Request): Promise<Response> {
  const token = await readToken(request);

  if (!token) {
    return NextResponse.json(
      { error: "invalid", message: FAILURE_MESSAGES.invalid },
      { status: 400 },
    );
  }

  return verify(request, token);
}

/** GET：直接访问链接（没有 JS 也能登录，只是合并不了游客态互动）。 */
export async function GET(request: Request): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token") ?? "";

  if (!token) {
    return NextResponse.json(
      { error: "invalid", message: FAILURE_MESSAGES.invalid },
      { status: 400 },
    );
  }

  return verify(request, token);
}
