/**
 * 认证配置：全部只从环境变量读。
 *
 * 三条原则（spec 决策 10 + 本票的硬性约束）：
 *
 *   1. **没有凭据就优雅降级**。少配一个环境变量，程序照常启动 ——
 *      只是对应的登录方式不可用（页面上明确写出来），而不是启动时崩掉。
 *   2. **密钥只从环境变量读**。绝不写进代码、绝不提交进仓库。
 *   3. **默认值只在"安全地退化"时存在**。会削弱安全性的默认值（签名密钥、
 *      令牌有效期）宁可报错，也不静默给一个弱默认值。
 */

/** 读一个非空的环境变量。空白视为没配。 */
function envString(name: string): string | null {
  const value = process.env[name];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** 读一个正整数环境变量；没配或配得不合理就用兜底值。 */
function envInt(name: string, fallback: number): number {
  const raw = envString(name);
  if (raw === null) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** 站点对外的绝对地址。没配就从请求的 origin 推导。 */
export function authBaseUrl(requestOrigin?: string): string {
  const configured = envString("AUTH_BASE_URL");
  if (configured) {
    return configured.replace(/\/+$/, "");
  }
  if (requestOrigin) {
    return requestOrigin.replace(/\/+$/, "");
  }
  return "http://localhost:3000";
}

/**
 * 会话 JWT 的签名密钥。
 *
 * 优先用专门的 `AUTH_SESSION_SECRET`；没配就退回 `INTERACTION_HASH_SECRET`
 * （游客态身份用的那把 HMAC 密钥），再退回 `DATABASE_URL`（同样带密钥性质、
 * 同样是环境变量，保证重启后密钥不变）。三样都没有 → 报错，不给弱默认值。
 */
export function sessionSecret(): string {
  const secret =
    envString("AUTH_SESSION_SECRET") ??
    envString("INTERACTION_HASH_SECRET") ??
    envString("DATABASE_URL");

  if (!secret) {
    throw new Error(
      "未配置会话签名密钥：请设置 AUTH_SESSION_SECRET（退而求其次用 INTERACTION_HASH_SECRET 或 DATABASE_URL）。",
    );
  }

  return secret;
}

/** 会话有效期（秒）。默认 30 天。 */
export function sessionTtlSeconds(): number {
  return envInt("AUTH_SESSION_TTL_SECONDS", 30 * 24 * 60 * 60);
}

/** 魔法链接有效期（秒）。默认 15 分钟 —— 够点一次，不够慢慢挑。 */
export function magicLinkTtlSeconds(): number {
  return envInt("AUTH_MAGIC_LINK_TTL_SECONDS", 15 * 60);
}

/** GitHub OAuth 的 state 有效期（秒）。默认 10 分钟。 */
export function oauthStateTtlSeconds(): number {
  return envInt("AUTH_OAUTH_STATE_TTL_SECONDS", 10 * 60);
}

/** 一类限流参数：窗口长度 + 窗口内上限。 */
export type RateLimit = {
  /** 窗口内的最大次数。 */
  max: number;
  /** 窗口长度（秒）。 */
  windowSeconds: number;
};

/**
 * 请求登录链接的限流参数。
 *
 * - **同一邮箱**：15 分钟内最多 5 次。挡住「拿一个邮箱疯狂发信」的骚扰。
 * - **同一 IP**：1 小时内最多 20 次。挡住「换邮箱狂发」的批量滥用。
 *
 * 两组参数都能用环境变量覆盖，方便按部署规模调。
 */
export function authEmailRateLimit(): RateLimit {
  return {
    max: envInt("AUTH_RATE_LIMIT_EMAIL_MAX", 5),
    windowSeconds: envInt("AUTH_RATE_LIMIT_EMAIL_WINDOW_SECONDS", 15 * 60),
  };
}

export function authIpRateLimit(): RateLimit {
  return {
    max: envInt("AUTH_RATE_LIMIT_IP_MAX", 20),
    windowSeconds: envInt("AUTH_RATE_LIMIT_IP_WINDOW_SECONDS", 60 * 60),
  };
}

/** GitHub OAuth 客户端配置。没配齐就算「不可用」，不崩。 */
export type GitHubOAuthConfig = {
  clientId: string;
  clientSecret: string;
  /** 授权范围：默认要邮箱（用于关联到同一个账号）。 */
  scope: string;
};

/** GitHub OAuth 是否已配置好。 */
export function isGitHubOAuthConfigured(): boolean {
  return Boolean(envString("GITHUB_OAUTH_CLIENT_ID") && envString("GITHUB_OAUTH_CLIENT_SECRET"));
}

/** 取 GitHub OAuth 配置。没配齐返回 null（调用方负责降级）。 */
export function gitHubOAuthConfig(): GitHubOAuthConfig | null {
  const clientId = envString("GITHUB_OAUTH_CLIENT_ID");
  const clientSecret = envString("GITHUB_OAUTH_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    return null;
  }
  return {
    clientId,
    clientSecret,
    scope: envString("GITHUB_OAUTH_SCOPE") ?? "read:user user:email",
  };
}

/** GitHub OAuth 的回调地址。没配 `GITHUB_OAUTH_REDIRECT_URI` 就按站点地址推。 */
export function gitHubOAuthRedirectUri(requestOrigin?: string): string {
  const configured = envString("GITHUB_OAUTH_REDIRECT_URI");
  if (configured) {
    return configured;
  }
  return `${authBaseUrl(requestOrigin)}/api/auth/github/callback`;
}

/** 邮件服务是否已配置成「真实发送」。 */
export function isRealEmailConfigured(): boolean {
  return envString("AUTH_EMAIL_SENDER") === "http" && Boolean(envString("AUTH_EMAIL_API_URL"));
}

/** 邮件服务配置（http 发送器用）。 */
export function httpEmailConfig(): {
  apiUrl: string;
  apiKey: string | null;
  from: string;
} | null {
  const apiUrl = envString("AUTH_EMAIL_API_URL");
  if (!apiUrl) {
    return null;
  }
  return {
    apiUrl,
    apiKey: envString("AUTH_EMAIL_API_KEY"),
    from: envString("AUTH_EMAIL_FROM") ?? "no-reply@com-ai.local",
  };
}
