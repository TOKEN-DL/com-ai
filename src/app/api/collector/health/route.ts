import { NextResponse } from "next/server";

import { getCollectionHealth } from "@/collector/alerts";
import { checkDatabase } from "@/lib/db-status";

// 健康检查必须实时读库，不许被静态化。
export const dynamic = "force-dynamic";

/**
 * GET /api/collector/health —— 采集健康状态。
 *
 * 回答的是「采集器还在正常干活吗」：
 *   - 每个源最近一次运行的结果与时间；
 *   - 每个源**连续失败**的次数；
 *   - 未确认的告警数（解析器失效 / 源结构变更会在这里露出来）。
 *
 * 状态码：
 *   - 200 —— 正常（`ok`）或降级但还能用（`degraded`）；
 *   - 503 —— 某个源连续失败达到阈值（`error`），采集已经不可用了。
 */
export async function GET(): Promise<Response> {
  const [health, database] = await Promise.all([getCollectionHealth(), checkDatabase()]);

  return NextResponse.json(
    {
      status: health.status,
      sources: health.sources,
      openAlerts: health.openAlerts,
      threshold: health.threshold,
      database,
    },
    { status: health.status === "error" ? 503 : 200 },
  );
}
