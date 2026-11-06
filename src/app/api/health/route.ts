import { NextResponse } from "next/server";

import { checkDatabase } from "@/lib/db-status";

// 健康检查必须实时读库，不许被静态化。
export const dynamic = "force-dynamic";

/**
 * GET /api/health —— 应用与数据库的健康状态。
 *
 * 数据库可用时返回 200，不可用时返回 503（容器 healthcheck 据此判定）。
 */
export async function GET(): Promise<Response> {
  const database = await checkDatabase();

  return NextResponse.json(
    {
      status: database.ok ? "ok" : "degraded",
      database,
    },
    { status: database.ok ? 200 : 503 },
  );
}
