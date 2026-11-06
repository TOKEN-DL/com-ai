/**
 * 运营入口的权限闸门。
 *
 * 运营抽查与举报处理是**站内管理能力**，不能对普通用户开放：
 *   - 没登录 → 401 + 引导登录；
 *   - 登录了但角色不是 MODERATOR / ADMIN → 403。
 *
 * 角色由 `User.role` 决定（schema 里已有 USER / MODERATOR / ADMIN）。
 * 目前没有「把自己升成运营」的界面 —— 站点所有者直接改库即可：
 * `UPDATE "User" SET role = 'ADMIN' WHERE email = 'you@example.com';`
 */
import { NextResponse } from "next/server";

import { getSessionUser, unauthorizedResponse, type SessionUser } from "@/lib/session";

/** 是不是运营（MODERATOR 或 ADMIN）。 */
export function isOperator(user: SessionUser | null | undefined): boolean {
  return user?.role === "MODERATOR" || user?.role === "ADMIN";
}

export type OperatorResolution =
  | { ok: true; operator: SessionUser }
  | { ok: false; response: Response };

/** 认出当前请求是不是运营；不是就把该回的回应准备好。 */
export async function resolveOperator(request: Request): Promise<OperatorResolution> {
  const session = await getSessionUser(request);

  if (!session) {
    return { ok: false, response: unauthorizedResponse("运营入口需要登录。") };
  }

  if (!isOperator(session)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "forbidden", message: "需要运营权限才能进入这个入口。" },
        { status: 403 },
      ),
    };
  }

  return { ok: true, operator: session };
}
