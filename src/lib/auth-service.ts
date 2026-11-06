/**
 * 登录的收尾：把「证明你是谁」变成「你现在是这个账号」。
 *
 * 两种登录方式（邮箱魔法链接 / GitHub OAuth）到这里汇合：
 *   1. 确认账号（找到或建出 User，邮箱已验证）；
 *   2. 合并游客态互动到账号名下（spec 决策 10「登录后自动合并到账号」）；
 *   3. 签发会话（JWT + `Session` 行）。
 *
 * ⚠️ **不要在这里再调 `favoriteAsset` / `likeAsset`**：合并由
 * `mergeGuestInteractionsToUser` 一把完成（#8 写的），它自己去重、
 * 自己保证计数不翻倍。重复调互动接口只会把计数算多。
 */
import type { User } from "@prisma/client";

import { normalizeEmail } from "@/lib/email-address";
import { clientIpFromRequest, hashClientIp, isValidDeviceId } from "@/lib/guest-identity";
import { mergeGuestInteractionsToUser } from "@/lib/interactions";
import { prisma } from "@/lib/prisma";
import { createSession } from "@/lib/session";

/** 游客态互动合并的结果（给用户看的说法）。 */
export type GuestMergeSummary = {
  /** 迁到账号名下的收藏条数。 */
  favorites: number;
  /** 迁到账号名下的点赞条数。 */
  likes: number;
  /** 账号本来就有、合并时被去重丢弃的收藏条数。 */
  favoritesDeduplicated: number;
  /** 账号本来就有、合并时被去重丢弃的点赞条数。 */
  likesDeduplicated: number;
};

/**
 * 按邮箱找到账号；没有就建一个。
 *
 * 走到这里说明**邮箱已经被验证过**（魔法链接点开了 / GitHub 给了已验证邮箱），
 * 所以 `emailVerifiedAt` 直接写上当前时刻。
 */
export async function findOrCreateUserByEmail(email: string): Promise<User> {
  const normalized = normalizeEmail(email);

  const existing = await prisma.user.findUnique({ where: { email: normalized } });
  if (existing) {
    if (!existing.emailVerifiedAt) {
      return prisma.user.update({
        where: { id: existing.id },
        data: { emailVerifiedAt: new Date() },
      });
    }
    return existing;
  }

  return prisma.user.create({
    data: { email: normalized, emailVerifiedAt: new Date() },
  });
}

/** GitHub 账号资料（只取我们用得到的字段）。 */
export type GitHubProfile = {
  /** GitHub 用户名（站内唯一）。 */
  login: string;
  /** 展示名。 */
  name: string | null;
  /** 头像地址。 */
  avatarUrl: string | null;
  /** 主邮箱（可能为 null —— 用户没设公开邮箱）。 */
  email: string | null;
};

/** 关联 GitHub 账号的结果。 */
export type LinkGitHubAccountResult =
  | { ok: true; user: User }
  | { ok: false; message: string };

/**
 * 把 GitHub 账号关联到站内账号。
 *
 * 关联顺序（**正确关联到同一个账号**的关键）：
 *   1. 已经绑过这个 GitHub 账号 → 直接用那个账号登录；
 *   2. 邮箱相同的账号还没绑 GitHub → **把 GitHub 绑上去**（同一个邮箱 = 同一个人的证明）；
 *   3. 都没有 → 建一个新账号。
 *
 * 邮箱相同但**已经绑了别的 GitHub 账号** → 拒绝（不能把别人的 GitHub 顶掉）。
 */
export async function linkGitHubAccount(
  profile: GitHubProfile,
): Promise<LinkGitHubAccountResult> {
  const email = profile.email ? normalizeEmail(profile.email) : null;

  if (!email) {
    return {
      ok: false,
      message: "GitHub 账号没有提供可用邮箱，无法完成登录。请在 GitHub 设置里添加邮箱后重试。",
    };
  }

  const byGithub = await prisma.user.findUnique({ where: { githubLogin: profile.login } });
  if (byGithub) {
    // 已经绑过了 —— 补一下可能变了的展示名与头像。
    return {
      ok: true,
      user: await prisma.user.update({
        where: { id: byGithub.id },
        data: {
          displayName: profile.name ?? byGithub.displayName,
          avatarUrl: profile.avatarUrl ?? byGithub.avatarUrl,
        },
      }),
    };
  }

  const byEmail = await prisma.user.findUnique({ where: { email } });
  if (byEmail) {
    if (byEmail.githubLogin && byEmail.githubLogin !== profile.login) {
      return {
        ok: false,
        message: "这个邮箱已经绑定了另一个 GitHub 账号，请用那个账号登录。",
      };
    }

    return {
      ok: true,
      user: await prisma.user.update({
        where: { id: byEmail.id },
        data: {
          githubLogin: profile.login,
          displayName: profile.name ?? byEmail.displayName,
          avatarUrl: profile.avatarUrl ?? byEmail.avatarUrl,
          emailVerifiedAt: byEmail.emailVerifiedAt ?? new Date(),
        },
      }),
    };
  }

  return {
    ok: true,
    user: await prisma.user.create({
      data: {
        email,
        githubLogin: profile.login,
        displayName: profile.name,
        avatarUrl: profile.avatarUrl,
        // GitHub 已经验证过这个邮箱的归属。
        emailVerifiedAt: new Date(),
      },
    }),
  };
}

/**
 * 登录成功后的收尾：合并游客态互动 + 签发会话。
 *
 * `deviceId` 取请求头 `x-device-id` 的**原文** ——
 * `mergeGuestInteractionsToUser` 内部自己哈希，调用方不碰密钥。
 */
export async function completeLogin(input: {
  userId: string;
  request: Request;
}): Promise<{
  session: { token: string; expiresAt: Date };
  merged: GuestMergeSummary;
}> {
  const { request } = input;

  // 合并游客态收藏 / 点赞。设备指纹取原文（内部哈希）。
  const deviceId = request.headers.get("x-device-id");
  let merged: GuestMergeSummary = {
    favorites: 0,
    likes: 0,
    favoritesDeduplicated: 0,
    likesDeduplicated: 0,
  };

  if (deviceId && isValidDeviceId(deviceId)) {
    try {
      const result = await mergeGuestInteractionsToUser({ userId: input.userId, deviceId });
      merged = {
        favorites: result.favorites,
        likes: result.likes,
        favoritesDeduplicated: result.favoritesDeduplicated,
        likesDeduplicated: result.likesDeduplicated,
      };
    } catch (error) {
      // 合并失败不该把登录也判死 —— 记一笔，登录照常完成。
      console.error("[auth] 合并游客态互动失败：", error);
    }
  }

  const ip = clientIpFromRequest(request);
  const session = await createSession({
    userId: input.userId,
    userAgent: request.headers.get("user-agent"),
    ipHash: ip ? hashClientIp(ip) : null,
  });

  return { session, merged };
}
