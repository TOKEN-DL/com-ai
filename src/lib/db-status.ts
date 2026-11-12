/**
 * 数据库连通性探测。
 *
 * 探测失败不抛错：首页与健康检查都要在库挂掉时照常渲染，把「连不上」这件事
 * 如实报出来，而不是让整个页面 500。
 */
import { prisma } from "./prisma";

export type DatabaseStatus = {
  /** 是否连得上。 */
  ok: boolean;
  /** 探测耗时（毫秒）；失败时为 null。 */
  latencyMs: number | null;
  /** 失败原因；成功时为 null。 */
  error: string | null;
};

export async function checkDatabase(): Promise<DatabaseStatus> {
  const startedAt = performance.now();

  try {
    await prisma.$queryRaw`SELECT 1`;
    return {
      ok: true,
      latencyMs: Math.round(performance.now() - startedAt),
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
