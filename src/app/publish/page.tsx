import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { resolveSessionUser, SESSION_COOKIE } from "@/lib/session";

import { PublishForm } from "./PublishForm";

// 发布页要读会话，不许被静态化。
export const dynamic = "force-dynamic";

/**
 * 发布页（票 #11）。
 *
 * **注册墙只出现在这一处**（spec 约束 7）：未登录 → 直接去登录页，
 * 进不了发布流程。邮箱验证通过即可发布。
 */
export default async function PublishPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  const user = await resolveSessionUser(token);

  if (!user) {
    redirect("/login");
  }

  return (
    <main>
      <h1>发布自己的资产</h1>
      <p className="lede">
        把你写的 Skill / MCP Server / Prompt 挂到市场上。发布后立刻可见 ——
        命中自动过滤或被举报才会下架。
      </p>

      <PublishForm />
    </main>
  );
}
