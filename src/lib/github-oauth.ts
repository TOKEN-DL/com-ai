/**
 * GitHub OAuth（spec 决策 10 的备选登录方式）。
 *
 * **没有客户端凭据时优雅降级**：`gitHubOAuthConfig()` 返回 null，
 * 页面把 GitHub 按钮置灰并说明「未配置」，点接口也只是 503 + 提示 ——
 * **绝不会因为少一个环境变量就在启动时崩**。
 *
 * 依赖：只用 Node 内置的 `fetch`，**不引入任何 OAuth SDK** ——
 * SDK 往往要求启动时就有凭据，那正是我们要避免的。
 */
import { gitHubOAuthConfig, gitHubOAuthRedirectUri } from "@/lib/auth-config";
import type { GitHubProfile } from "@/lib/auth-service";

/** GitHub 授权端点。 */
const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
/** GitHub 令牌交换端点。 */
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
/** GitHub 用户资料端点。 */
const USER_URL = "https://api.github.com/user";
/** GitHub 邮箱列表端点（需要 user:email 范围）。 */
const USER_EMAILS_URL = "https://api.github.com/user/emails";

/** OAuth 流程里出错了 —— 消息是**给用户看的**。 */
export class GitHubOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubOAuthError";
  }
}

/** GitHub API 的请求头。 */
function apiHeaders(accessToken: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${accessToken}`,
    "user-agent": "com-ai",
    "x-github-api-version": "2022-11-28",
  };
}

/** 拼出 GitHub 授权页地址（用户点「用 GitHub 登录」后被带过去的地方）。 */
export function buildGitHubAuthorizeUrl(input: {
  state: string;
  redirectUri: string;
  scope: string;
  clientId: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", input.scope);
  url.searchParams.set("state", input.state);
  url.searchParams.set("allow_signup", "true");
  return url.toString();
}

/** 用授权码换一个访问令牌。 */
export async function exchangeGitHubCode(input: {
  code: string;
  redirectUri: string;
}): Promise<string> {
  const config = gitHubOAuthConfig();
  if (!config) {
    throw new GitHubOAuthError("未配置 GitHub OAuth 客户端，当前环境无法使用 GitHub 登录。");
  }

  let response: Response;
  try {
    response = await fetch(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code: input.code,
        redirect_uri: input.redirectUri,
      }),
    });
  } catch {
    throw new GitHubOAuthError("联系 GitHub 失败，请稍后再试。");
  }

  if (!response.ok) {
    throw new GitHubOAuthError("GitHub 令牌交换失败，请重新发起登录。");
  }

  const body = (await response.json()) as { access_token?: string; error_description?: string };

  if (!body.access_token) {
    throw new GitHubOAuthError(body.error_description ?? "GitHub 没有返回访问令牌，请重新发起登录。");
  }

  return body.access_token;
}

/** 取 GitHub 用户资料（拿不到邮箱时再问一次邮箱列表）。 */
export async function fetchGitHubProfile(accessToken: string): Promise<GitHubProfile> {
  let response: Response;
  try {
    response = await fetch(USER_URL, { headers: apiHeaders(accessToken) });
  } catch {
    throw new GitHubOAuthError("读取 GitHub 账号资料失败，请稍后再试。");
  }

  if (!response.ok) {
    throw new GitHubOAuthError("读取 GitHub 账号资料失败，请重新发起登录。");
  }

  const profile = (await response.json()) as {
    login?: string;
    name?: string | null;
    avatar_url?: string | null;
    email?: string | null;
  };

  if (!profile.login) {
    throw new GitHubOAuthError("GitHub 没有返回账号信息，请重新发起登录。");
  }

  let email = profile.email ?? null;

  // 用户没设公开邮箱时，问一次邮箱列表（scope 里有 user:email）。
  if (!email) {
    email = await fetchPrimaryVerifiedEmail(accessToken);
  }

  return {
    login: profile.login,
    name: profile.name ?? null,
    avatarUrl: profile.avatar_url ?? null,
    email,
  };
}

/** 从 GitHub 邮箱列表里挑「主邮箱」；挑不到就挑第一个已验证的。 */
async function fetchPrimaryVerifiedEmail(accessToken: string): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(USER_EMAILS_URL, { headers: apiHeaders(accessToken) });
  } catch {
    return null;
  }

  if (!response.ok) {
    return null;
  }

  const emails = (await response.json()) as {
    email?: string;
    primary?: boolean;
    verified?: boolean;
  }[];

  const primary = emails.find((item) => item.primary && item.verified && item.email);
  if (primary?.email) {
    return primary.email;
  }

  const anyVerified = emails.find((item) => item.verified && item.email);
  return anyVerified?.email ?? null;
}

/** 回调地址（优先用 `GITHUB_OAUTH_REDIRECT_URI`，否则按站点地址推）。 */
export function resolveRedirectUri(requestOrigin?: string): string {
  return gitHubOAuthRedirectUri(requestOrigin);
}
