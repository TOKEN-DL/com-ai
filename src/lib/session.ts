/**
 * 会话模块：签发 + 读取 + 失效。
 *
 * 设计约定（spec 决策 10「令牌用 JWT」+ #8 已经定下的落库方式）：
 *
 *   - cookie 名：`com-ai-session`；
 *   - cookie 里放**明文的 JWT**（HS256 签名），库里的 `Session.tokenHash`
 *     存它的 **SHA-256** —— 明文令牌不进数据库（#8 的约定，本票沿用）；
 *   - JWT 的 `exp` 与 `Session.expiresAt` 对齐：两者都过了才算过期；
 *   - `Session` 行被删（登出）后，即使 JWT 本身还没到期也立刻失效 ——
 *     **服务端说了算**，不是客户端拿着签名就能一直用。
 *
 * #8 留下的 `getSessionUser(request)` 调用签名**保持不变**（#10 的评论直接用它），
 * 本票只是把它从「只读的一侧」补成完整模块。
 */
import { createHash, randomUUID } from "node:crypto";

import { SignJWT, jwtVerify } from "jose";
import { NextResponse } from "next/server";
import type { UserRole } from "@prisma/client";

import { sessionSecret, sessionTtlSeconds } from "@/lib/auth-config";
import { prisma } from "@/lib/prisma";

/** 会话 cookie 名。 */
export const SESSION_COOKIE = "com-ai-session";

/** 当前会话对应的用户。 */
export type SessionUser = {
  id: string;
  email: string;
  displayName: string | null;
  role: UserRole;
};

/** 会话令牌 → 落库的哈希（`Session.tokenHash`）。 */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 从请求头里读会话 cookie 的值。 */
export function readSessionCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) {
    return null;
  }

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) {
      continue;
    }
    const key = part.slice(0, separator).trim();
    if (key !== SESSION_COOKIE) {
      continue;
    }
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return part.slice(separator + 1).trim();
    }
  }

  return null;
}

/** 签名密钥（字节形式）。 */
function signingKey(): Uint8Array {
  return new TextEncoder().encode(sessionSecret());
}

/** 签一个会话 JWT。 */
async function signSessionToken(input: {
  userId: string;
  sessionId: string;
  expiresAt: Date;
}): Promise<string> {
  return new SignJWT({ sid: input.sessionId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(input.userId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(input.expiresAt.getTime() / 1000))
    .sign(signingKey());
}

/**
 * 校验会话 JWT。
 *
 * 签名不对、格式不对、已经过期 —— 一律返回 null（= 未登录），不抛异常。
 */
async function verifySessionToken(
  token: string,
): Promise<{ userId: string; sessionId: string } | null> {
  try {
    const { payload } = await jwtVerify(token, signingKey(), { algorithms: ["HS256"] });
    if (typeof payload.sub !== "string" || typeof payload.sid !== "string") {
      return null;
    }
    return { userId: payload.sub, sessionId: payload.sid };
  } catch {
    return null;
  }
}

/**
 * 新建一个会话：签 JWT + 落 `Session` 行。
 *
 * 返回**明文令牌**（只有这一次会出现在内存里），调用方负责放进 cookie。
 */
export async function createSession(input: {
  userId: string;
  userAgent?: string | null;
  ipHash?: string | null;
}): Promise<{ token: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + sessionTtlSeconds() * 1000);

  // 自己生成会话 id —— 先有 id 才能把 sid 放进 JWT，
  // 于是只需要**一次**插入（不用先插一行再回填 tokenHash：
  // 那样的占位值会撞 unique 约束）。
  const sessionId = randomUUID();

  const token = await signSessionToken({
    userId: input.userId,
    sessionId,
    expiresAt,
  });

  await prisma.session.create({
    data: {
      id: sessionId,
      userId: input.userId,
      tokenHash: hashSessionToken(token),
      expiresAt,
      userAgent: input.userAgent ?? null,
      ipHash: input.ipHash ?? null,
      lastUsedAt: new Date(),
    },
  });

  return { token, expiresAt };
}

/**
 * 让会话失效（登出）。删掉 `Session` 行即可 —— JWT 还在也没用了。
 */
export async function revokeSession(token: string): Promise<void> {
  await prisma.session.deleteMany({ where: { tokenHash: hashSessionToken(token) } });
}

/** `lastUsedAt` 的更新频率：5 分钟内不重复写。 */
const LAST_USED_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

async function touchSession(sessionId: string, lastUsedAt: Date | null): Promise<void> {
  const now = Date.now();
  if (lastUsedAt && now - lastUsedAt.getTime() < LAST_USED_TOUCH_INTERVAL_MS) {
    return;
  }

  try {
    await prisma.session.update({
      where: { id: sessionId },
      data: { lastUsedAt: new Date(now) },
    });
  } catch {
    // 记账失败不该把登录状态也判死 —— 忽略即可。
  }
}

/**
 * 给定令牌，查出它对应的用户。
 *
 * 令牌为空、签名不对、已过期、`Session` 行不存在（被登出）—— 一律 null（= 游客态）。
 */
export async function resolveSessionUser(
  token: string | null | undefined,
): Promise<SessionUser | null> {
  if (!token) {
    return null;
  }

  const payload = await verifySessionToken(token);
  if (!payload) {
    return null;
  }

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    include: { user: true },
  });

  if (!session || session.expiresAt.getTime() <= Date.now()) {
    return null;
  }

  // JWT 里的用户与会话行对不上 → 当作伪造处理。
  if (session.userId !== payload.userId) {
    return null;
  }

  await touchSession(session.id, session.lastUsedAt);

  return {
    id: session.user.id,
    email: session.user.email,
    displayName: session.user.displayName,
    role: session.user.role,
  };
}

/**
 * 取当前请求对应的登录用户。
 *
 * 没有 cookie、令牌对不上、或者会话已过期，都返回 null（= 游客态）。
 */
export async function getSessionUser(request: Request): Promise<SessionUser | null> {
  return resolveSessionUser(readSessionCookie(request));
}

/** 设置会话 cookie 的 `Set-Cookie` 头。 */
export function sessionCookieHeader(token: string, expiresAt: Date): string {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";

  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    `Expires=${expiresAt.toUTCString()}`,
    secure,
  ]
    .filter(Boolean)
    .join("; ");
}

/** 清掉会话 cookie 的 `Set-Cookie` 头。 */
export function clearedSessionCookieHeader(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";

  return [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0", secure]
    .filter(Boolean)
    .join("; ");
}

/**
 * 受保护操作的「未登录」回应。
 *
 * 统一口径：401 + **用户能看懂**的提示 + 登录页地址。
 * 不泄漏任何敏感数据（不回显用户信息、不回显令牌）。
 */
export function unauthorizedResponse(message = "请先登录后再试。"): Response {
  return NextResponse.json(
    { error: "unauthenticated", message, loginUrl: "/login" },
    { status: 401 },
  );
}
