/**
 * 发布与审核的**准入判定**。
 *
 * ## 发布门槛
 *
 * spec 决策 11：发布门槛 = **邮箱验证通过**。
 * 判定方式：会话有效 **且** `User.emailVerifiedAt` 非空。
 *
 * 两条登录路径（邮箱魔法链接 / GitHub OAuth）落库时都会写上 `emailVerifiedAt`
 * （见 `findOrCreateUserByEmail` / `linkGitHubAccount`），所以正常情况下
 * 「有会话」就等于「邮箱已验证」。这里仍然显式查一次库：
 * 门槛是**业务规则**，不能靠「恰好都这样」成立。
 *
 * ## 审核门槛
 *
 * 人工抽查 / 处理举报是运营的活：角色必须是 MODERATOR 或 ADMIN。
 */
import { NextResponse } from "next/server";
import type { UserRole } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { getSessionUser, unauthorizedResponse } from "@/lib/session";

export type GateFailure = { ok: false; response: Response };
export type GateSuccess<T> = { ok: true } & T;

/**
 * 发布门槛：必须是**邮箱已验证**的登录用户。
 *
 * 失败时：
 *   - 没登录 → 401，引导去登录页；
 *   - 登录了但邮箱没验证 → 403，说明为什么不能发。
 */
export async function requireVerifiedPublisher(
  request: Request,
): Promise<GateSuccess<{ userId: string; email: string }> | GateFailure> {
  const session = await getSessionUser(request);
  if (!session) {
    return {
      ok: false,
      response: unauthorizedResponse("发布自己的资产需要先登录（邮箱验证即可）。"),
    };
  }

  const user = await prisma.user.findUnique({
    where: { id: session.id },
    select: { id: true, email: true, emailVerifiedAt: true },
  });

  if (!user || !user.emailVerifiedAt) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "email_not_verified", message: "邮箱尚未验证，暂时不能发布资产。" },
        { status: 403 },
      ),
    };
  }

  return { ok: true, userId: user.id, email: user.email };
}

/** 运营角色。 */
export type ModeratorUser = { userId: string; role: UserRole };

/**
 * 审核门槛：必须是 MODERATOR 或 ADMIN。
 *
 * 没登录 → 401；登录了但不是运营 → 403。
 */
export async function requireModerator(
  request: Request,
): Promise<GateSuccess<{ moderator: ModeratorUser }> | GateFailure> {
  const session = await getSessionUser(request);
  if (!session) {
    return { ok: false, response: unauthorizedResponse("请先登录后再试。") };
  }

  if (session.role !== "MODERATOR" && session.role !== "ADMIN") {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "forbidden", message: "只有运营可以执行这个操作。" },
        { status: 403 },
      ),
    };
  }

  return { ok: true, moderator: { userId: session.id, role: session.role } };
}
