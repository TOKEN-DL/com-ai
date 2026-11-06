/**
 * 会话读取（最小实现）。
 *
 * ⚠️ **签发**会话是 #9（邮箱验证登录）的事，本票不实现登录流程。
 * 这里只提供「读」的一侧：把请求里的会话 cookie 换成 userId，
 * 好让「我的收藏」这类页面知道当前是游客还是账号。
 *
 * 设计约定（#9 接手时按这个来，或直接换掉本文件）：
 *   - cookie 名：`com-ai-session`；
 *   - cookie 里放**明文随机令牌**，库里只存它的 SHA-256（`Session.tokenHash`）；
 *   - 令牌过期后 `getSessionUser` 返回 null。
 */
import { createHash } from "node:crypto";

import { prisma } from "@/lib/prisma";

/** 会话 cookie 名。 */
export const SESSION_COOKIE = "com-ai-session";

/** 当前会话对应的用户（已验证邮箱的账号才有会话）。 */
export type SessionUser = {
  id: string;
  email: string;
};

/** 会话令牌 → 落库的哈希（`Session.tokenHash`）。 */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 从请求头里读一个 cookie 值。 */
function readCookie(request: Request, name: string): string | null {
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
    if (key !== name) {
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

/**
 * 取当前请求对应的登录用户。
 *
 * 没有 cookie、令牌对不上、或者会话已过期，都返回 null（= 游客态）。
 */
export async function getSessionUser(request: Request): Promise<SessionUser | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) {
    return null;
  }

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    include: { user: true },
  });

  if (!session || session.expiresAt.getTime() <= Date.now()) {
    return null;
  }

  return { id: session.user.id, email: session.user.email };
}
