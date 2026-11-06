/**
 * GET /api/auth/github —— 发起 GitHub OAuth 登录。
 *
 * **没配客户端凭据时优雅降级**：返回 503 + 一句用户能看懂的提示，
 * 绝不抛异常、绝不崩。登录页也会据此把 GitHub 按钮置灰。
 *
 * 流程：生成一次性 state → 落 `LoginToken` → 302 到 GitHub 授权页。
 */
import { LoginTokenPurpose } from "@prisma/client";
import { NextResponse } from "next/server";

import { gitHubOAuthConfig, oauthStateTtlSeconds } from "@/lib/auth-config";
import { buildGitHubAuthorizeUrl, resolveRedirectUri } from "@/lib/github-oauth";
import { clientIpFromRequest, hashClientIp } from "@/lib/guest-identity";
import { AuthRateLimitError, createLoginToken } from "@/lib/login-tokens";

// 要读环境变量 + 写库，不许被静态化。
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
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

  const ip = clientIpFromRequest(request);
  const ipHash = ip ? hashClientIp(ip) : null;

  let state;
  try {
    state = await createLoginToken({
      purpose: LoginTokenPurpose.GITHUB_OAUTH,
      ipHash,
      ttlSeconds: oauthStateTtlSeconds(),
    });
  } catch (error) {
    if (error instanceof AuthRateLimitError) {
      return NextResponse.json(
        {
          error: "rate_limited",
          message: error.message,
          retryAfterSeconds: error.retryAfterSeconds,
        },
        { status: 429, headers: { "Retry-After": String(error.retryAfterSeconds) } },
      );
    }
    throw error;
  }

  const redirectUri = resolveRedirectUri(new URL(request.url).origin);
  const authorizeUrl = buildGitHubAuthorizeUrl({
    state: state.token,
    redirectUri,
    scope: config.scope,
    clientId: config.clientId,
  });

  return NextResponse.redirect(authorizeUrl);
}
