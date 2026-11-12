/**
 * HTTP 边界（spec 的 Seam 2）：路由处理器对着**真实测试 Postgres** 跑。
 */
import { describe, expect, it } from "vitest";

import { GET } from "@/app/api/health/route";

describe("GET /api/health", () => {
  it("数据库连通时返回 200 与连通状态", async () => {
    const response = await GET();

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.status).toBe("ok");
    expect(body.database.ok).toBe(true);
    expect(body.database.error).toBeNull();
    expect(typeof body.database.latencyMs).toBe("number");
  });
});
