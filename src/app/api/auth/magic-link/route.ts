/**
 * POST /api/auth/magic-link —— 请求一个邮箱登录链接。
 *
 * 流程：生成一次性令牌 → 落 `LoginToken` → 通过 `EmailSender` 发信。
 *
 * 两道防滥用闸门：
 *   1. **限流**：同一邮箱 / 同一 IP 的频率上限（见 src/lib/login-tokens.ts），
 *      超出返回 429 + **明确的**提示文案；
 *   2. **不回显是否注册过**：不管这个邮箱有没有账号，回应都一样 ——
 *      避免用「有没有收到信」探测别人的邮箱有没有账号。
 *
 * 开发模式（没配邮件服务）时，链接会出现在响应体的 `devLink` 里，
 * 页面上会明确写出「当前环境未配置邮件服务」。
 */
import { LoginTokenPurpose } from "@prisma/client";
import { NextResponse } from "next/server";

import { authBaseUrl, magicLinkTtlSeconds } from "@/lib/auth-config";
import { getEmailSender } from "@/lib/email";
import { isValidEmail, normalizeEmail } from "@/lib/email-address";
import { clientIpFromRequest, hashClientIp } from "@/lib/guest-identity";
import { AuthRateLimitError, createLoginToken, invalidateLoginToken } from "@/lib/login-tokens";

// 要实时读库 + 读环境变量，不许被静态化。
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let rawEmail = "";

  try {
    const body = (await request.json()) as { email?: unknown };
    if (typeof body?.email === "string") {
      rawEmail = body.email;
    }
  } catch {
    // 请求体不是合法 JSON —— 当成没填邮箱。
  }

  if (!isValidEmail(rawEmail)) {
    return NextResponse.json(
      { error: "invalid_email", message: "请输入有效的邮箱地址。" },
      { status: 400 },
    );
  }

  const email = normalizeEmail(rawEmail);
  const ip = clientIpFromRequest(request);
  const ipHash = ip ? hashClientIp(ip) : null;

  let created;
  try {
    created = await createLoginToken({
      purpose: LoginTokenPurpose.EMAIL_MAGIC,
      email,
      ipHash,
      ttlSeconds: magicLinkTtlSeconds(),
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

  // 链接指向**登录页**而不是校验接口：登录页在浏览器里校验令牌时会带上
  // `x-device-id` 请求头，服务端才能把游客态的收藏 / 点赞合并到账号名下。
  const link = `${authBaseUrl(new URL(request.url).origin)}/login?token=${encodeURIComponent(created.token)}`;
  const sender = getEmailSender();

  try {
    await sender.sendMagicLink({ to: email, link, expiresAt: created.expiresAt });
  } catch {
    // 发不出去的链接就不该还能用 —— 立刻作废。
    await invalidateLoginToken(created.token);
    return NextResponse.json(
      { error: "email_failed", message: "登录链接发送失败，请稍后再试。" },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    message: "登录链接已生成，请到邮箱查收。",
    emailDelivery: sender.id,
    expiresAt: created.expiresAt.toISOString(),
    // 开发模式（控制台发送器）才回显链接 —— 生产环境回显等于把登录链接公开。
    ...(sender.exposesLink ? { devLink: link } : {}),
  });
}
