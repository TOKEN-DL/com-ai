/**
 * 一次性登录令牌：邮箱魔法链接与 GitHub OAuth 的 state。
 *
 * 与 `Session` 的分工：
 *   - 本模块的令牌**一次性、短期**，用来证明「你就是这个邮箱 / 这个 GitHub 账号的主人」；
 *   - `Session`（src/lib/session.ts）**可撤销、可复用**，用来证明「你现在是这个账号」。
 *
 * 三条硬规矩：
 *   1. **只存哈希**：明文令牌只在生成那一次活在内存与链接里，落库的是 SHA-256；
 *   2. **一次性**：`usedAt` 一旦写上，同一个令牌再来一律拒绝；
 *   3. **有有效期**：`expiresAt` 过了就拒绝。
 *
 * 这张表同时是「请求登录链接」的限流账本：窗口内发了多少条，
 * 按 email / ipHash 数它自己就行，不必再开一张限流表。
 */
import { createHash, randomBytes } from "node:crypto";

import { LoginTokenPurpose } from "@prisma/client";

import { authEmailRateLimit, authIpRateLimit } from "@/lib/auth-config";
import { prisma } from "@/lib/prisma";

/** 限流触发时抛出。路由把它翻译成 429 + **用户可见**的提示文案。 */
export class AuthRateLimitError extends Error {
  /** 建议等待的秒数（当前限流窗口的长度）。 */
  readonly retryAfterSeconds: number;
  /** 触发的是哪一条限流：同一邮箱 / 同一 IP。 */
  readonly scope: "email" | "ip";

  constructor(input: { scope: "email" | "ip"; retryAfterSeconds: number; message: string }) {
    super(input.message);
    this.name = "AuthRateLimitError";
    this.scope = input.scope;
    this.retryAfterSeconds = input.retryAfterSeconds;
  }
}

/** 令牌哈希 → 落库值。 */
function hashLoginToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 把秒数说成人话（「15 分钟」/「1 小时」）。 */
function humanizeSeconds(seconds: number): string {
  if (seconds % 3600 === 0 && seconds >= 3600) {
    return `${seconds / 3600} 小时`;
  }
  if (seconds % 60 === 0 && seconds >= 60) {
    return `${seconds / 60} 分钟`;
  }
  return `${seconds} 秒`;
}

/**
 * 生成一个一次性登录令牌并落库。
 *
 * 限流判定与写入在**同一个事务**里，并且用 Postgres 的事务级咨询锁
 * （`pg_advisory_xact_lock`）把同一邮箱 / 同一 IP 的并发请求排队 ——
 * 不排队的话，两个并发请求会同时数到「还差一个名额」，然后一起放行。
 */
export async function createLoginToken(input: {
  purpose: LoginTokenPurpose;
  email?: string | null;
  ipHash?: string | null;
  ttlSeconds: number;
}): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashLoginToken(token);
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);
  const email = input.email ?? null;
  const ipHash = input.ipHash ?? null;

  await prisma.$transaction(async (tx) => {
    // 同一邮箱、同一 IP 各自排队过闸。
    // `pg_advisory_xact_lock` 返回 void，Prisma 反序列化不了 → 显式转成 text。
    if (email) {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`auth-email:${email}`}, 0))::text AS "locked"`;
    }
    if (ipHash) {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`auth-ip:${ipHash}`}, 0))::text AS "locked"`;
    }

    if (email) {
      const { max, windowSeconds } = authEmailRateLimit();
      const used = await tx.loginToken.count({
        where: {
          purpose: LoginTokenPurpose.EMAIL_MAGIC,
          email,
          createdAt: { gte: new Date(Date.now() - windowSeconds * 1000) },
        },
      });

      if (used >= max) {
        throw new AuthRateLimitError({
          scope: "email",
          retryAfterSeconds: windowSeconds,
          message: `这个邮箱请求登录链接太频繁了，请 ${humanizeSeconds(windowSeconds)} 后再试。`,
        });
      }
    }

    if (ipHash) {
      const { max, windowSeconds } = authIpRateLimit();
      const used = await tx.loginToken.count({
        where: {
          ipHash,
          createdAt: { gte: new Date(Date.now() - windowSeconds * 1000) },
        },
      });

      if (used >= max) {
        throw new AuthRateLimitError({
          scope: "ip",
          retryAfterSeconds: windowSeconds,
          message: `你的网络请求登录链接太频繁了，请 ${humanizeSeconds(windowSeconds)} 后再试。`,
        });
      }
    }

    await tx.loginToken.create({
      data: {
        tokenHash,
        purpose: input.purpose,
        email,
        expiresAt,
        ipHash,
      },
    });
  });

  return { token, expiresAt };
}

/** 校验失败的原因。 */
export type LoginTokenFailure = "invalid" | "expired" | "used";

/** 校验并**作废**一个登录令牌。 */
export type ConsumeLoginTokenResult =
  | { ok: true; email: string | null }
  | { ok: false; reason: LoginTokenFailure };

/**
 * 校验一个登录令牌，校验通过就**立刻作废**（一次性）。
 *
 * 作废用条件更新（`usedAt IS NULL`）而不是「先查后改」：
 * 两个并发请求只有一个能把 `usedAt` 写成非空，第二个自然被判成「已用过」。
 */
export async function consumeLoginToken(
  token: string,
  purpose: LoginTokenPurpose,
): Promise<ConsumeLoginTokenResult> {
  if (!token) {
    return { ok: false, reason: "invalid" };
  }

  const row = await prisma.loginToken.findUnique({ where: { tokenHash: hashLoginToken(token) } });

  if (!row || row.purpose !== purpose) {
    return { ok: false, reason: "invalid" };
  }
  if (row.usedAt) {
    return { ok: false, reason: "used" };
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: "expired" };
  }

  const consumed = await prisma.loginToken.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: new Date() },
  });

  if (consumed.count === 0) {
    // 并发请求里别人先一步用掉了。
    return { ok: false, reason: "used" };
  }

  return { ok: true, email: row.email };
}

/**
 * 让一个登录令牌作废（邮件发送失败时用 —— 发不出去的链接不该还能用）。
 */
export async function invalidateLoginToken(token: string): Promise<void> {
  await prisma.loginToken.updateMany({
    where: { tokenHash: hashLoginToken(token), usedAt: null },
    data: { usedAt: new Date() },
  });
}
