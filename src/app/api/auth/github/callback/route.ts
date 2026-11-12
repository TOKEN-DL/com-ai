/**
 * GET /api/auth/github/callback —— GitHub OAuth 回调。
 *
 * 流程：校验一次性 state → 换访问令牌 → 读 GitHub 账号资料 →
 *       关联到站内账号（邮箱相同的算同一个账号）→ 签发会话 → 合并游客态互动。
 *
 * 任何一步失败都**不抛给用户**，而是回到登录页并带上说得清的原因 ——
 * OAuth 回调是浏览器直接访问的地址，抛异常只会给用户一个白屏。
 */
import { NextResponse } from "next/server";

import { completeLogin, linkGitHubAccount } from "@/lib/auth-service";
import { authBaseUrl, gitHubOAuthConfig } from "@/lib/auth-config";
import {
  exchangeGitHubCode,
  fetchGitHubProfile,
  GitHubOAuthError,
  resolveRedirectUri,
} from "@/lib/github-oauth";
import { consumeLoginToken } from "@/lib/login-tokens";
import { sessionCookieHeader } from "@/lib/session";
import { LoginTokenPurpose } from "@prisma/client";

// 要读环境变量 + 写库，不许被静态化。
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const base = authBaseUrl(url.origin);

  const config = gitHubOAuthConfig();
  if (!config) {
    return NextResponse.json(
      {
        error: "not_configured",
        message: "未配置 GitHub OAuth 客户端，当前环境无法使用 GitHub 登录。",
      },
      { status: 503 },
    );
  }

  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";

  if (!code || !state) {
    return NextResponse.redirect(`${base}/login?status=invalid`);
  }

  // state 一次性：用掉就作废，重复回调拿不到会话。
  const consumed = await consumeLoginToken(state, LoginTokenPurpose.GITHUB_OAUTH);
  if (!consumed.ok) {
    return NextResponse.redirect(`${base}/login?status=${consumed.reason}`);
  }

  try {
    const accessToken = await exchangeGitHubCode({
      code,
      redirectUri: resolveRedirectUri(url.origin),
    });
    const profile = await fetchGitHubProfile(accessToken);
    const linked = await linkGitHubAccount(profile);

    if (!linked.ok) {
      const target = new URL(`${base}/login`);
      target.searchParams.set("status", "github_error");
      target.searchParams.set("message", linked.message);
      return NextResponse.redirect(target.toString());
    }

    const { session, merged } = await completeLogin({ userId: linked.user.id, request });

    const target = new URL(`${base}/login`);
    target.searchParams.set("status", "ok");
    target.searchParams.set("mergedFavorites", String(merged.favorites));
    target.searchParams.set("mergedLikes", String(merged.likes));
    target.searchParams.set("mergedFavoritesDeduplicated", String(merged.favoritesDeduplicated));
    target.searchParams.set("mergedLikesDeduplicated", String(merged.likesDeduplicated));

    return NextResponse.redirect(target.toString(), {
      headers: { "set-cookie": sessionCookieHeader(session.token, session.expiresAt) },
    });
  } catch (error) {
    const message =
      error instanceof GitHubOAuthError ? error.message : "GitHub 登录失败，请重新发起登录。";

    const target = new URL(`${base}/login`);
    target.searchParams.set("status", "github_error");
    target.searchParams.set("message", message);
    return NextResponse.redirect(target.toString());
  }
}
