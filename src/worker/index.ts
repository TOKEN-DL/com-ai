/**
 * 定时任务容器入口。
 *
 * #2 交付了「调度骨架」：容器能起来、能连上 Postgres、能按 cron 表达式触发任务、
 * 有可被容器 healthcheck 探测的 /healthz。#6 在这个骨架上接入**采集管道**：
 * 每个数据源一条**独立 cron**（高频源与低频源节奏不同，不做统一轮询）。
 *
 * ⚠️ 采集 cron 的**唯一归属是这个容器**：
 *    之前采集跑在应用容器里（`src/instrumentation.ts`），有两个问题：
 *      1. 应用容器一多，**每个副本都会各自触发一次采集** —— 重复采集是正确性 bug；
 *      2. 采集负载（回源 GitHub / skills.sh）与请求服务在同一个容器里抢资源。
 *    现在应用容器只服务请求；采集由本容器负责，并用 Postgres advisory lock
 *    做**单飞保护**（`src/collector/collection-lock.ts`）：即使本容器被扩到多副本，
 *    同一个采集源也只有一个实例真的采集。
 *
 * 调度器实现仍然只有这一份（`src/worker/scheduler.ts`），两边共用。
 *
 * 不用 Prisma 做心跳：这里只做「能不能连上库」的心跳，用 pg 直连更轻。
 * 但**采集入库仍然走 Prisma**（唯一写入路径 `src/lib/asset-writer.ts`），
 * 所以镜像里带着已生成的 Prisma 客户端（见 Dockerfile 的 worker 阶段）。
 */
import { createServer } from "node:http";

import { Pool } from "pg";

import { createScheduler } from "@/worker/scheduler";

const PORT = Number(process.env.WORKER_PORT ?? 3001);
const SCHEDULE = process.env.CRON_SCHEDULE ?? "0 * * * *";
const DATABASE_URL = process.env.DATABASE_URL ?? "";

const scheduler = createScheduler();

/** 采集 cron 模块（动态导入：拿到之后才能查它注册了哪些任务）。 */
type CollectionCronModule = typeof import("@/collector/collection-cron");
let collectionCron: CollectionCronModule | null = null;

/** 心跳任务：确认调度器活着，且 Postgres 连得上。 */
async function heartbeat(): Promise<void> {
  if (!DATABASE_URL) {
    throw new Error("缺少 DATABASE_URL，无法做数据库心跳");
  }

  const pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5_000 });
  try {
    await pool.query("SELECT 1");
  } finally {
    await pool.end();
  }
}

/** 采集健康状态（连续失败次数、未确认告警数）。用 pg 直连，不引 Prisma。 */
async function readCollectionHealth(): Promise<unknown> {
  if (!DATABASE_URL) {
    return { error: "缺少 DATABASE_URL" };
  }

  const pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5_000 });
  try {
    const runs = await pool.query<{
      source: string;
      status: string;
      error: string | null;
      started_at: Date;
    }>(
      `SELECT source, status, error, "startedAt" AS started_at FROM "CollectionRun"
       ORDER BY "startedAt" DESC LIMIT 50`,
    );
    const alerts = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "CollectionAlert" WHERE "acknowledgedAt" IS NULL`,
    );

    const sources = new Map<string, { status: string; error: string | null; at: string }>();
    for (const row of runs.rows) {
      if (!sources.has(row.source)) {
        sources.set(row.source, {
          status: row.status,
          error: row.error,
          at: new Date(row.started_at).toISOString(),
        });
      }
    }

    return {
      sources: [...sources.entries()].map(([source, info]) => ({ source, ...info })),
      openAlerts: Number(alerts.rows[0]?.count ?? 0),
    };
  } finally {
    await pool.end();
  }
}

/**
 * 启动采集 cron —— **采集调度的唯一归属**。
 *
 * 动态导入：采集管道依赖 node-cron、磁盘缓存与 Prisma（已生成的客户端），
 * 打包产物 worker.mjs 之外还要靠镜像里的 node_modules 才能跑起来。
 *
 * 关闭开关：`COLLECTOR_CRON_ENABLED=false`（例如只想跑心跳的排障环境）。
 */
async function startCollectionCronIfEnabled(): Promise<void> {
  if (process.env.COLLECTOR_CRON_ENABLED === "false") {
    console.log("[cron] COLLECTOR_CRON_ENABLED=false，不启动采集 cron");
    return;
  }
  collectionCron = await import("@/collector/collection-cron");
  await collectionCron.startCollectionCron();
}

const server = createServer((req, res) => {
  if (req.url !== "/healthz") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  void (async () => {
    let collection: unknown = { error: "未取到" };
    try {
      collection = await readCollectionHealth();
    } catch (error) {
      collection = { error: error instanceof Error ? error.message : String(error) };
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        schedule: SCHEDULE,
        jobs: scheduler.status(),
        // 采集 cron 注册了哪些任务（每个源一条独立 cron）。
        collectionJobs: collectionCron?.collectionCronStatus() ?? [],
        collection,
      }),
    );
  })();
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[cron] 定时任务容器已启动，健康检查端口 ${PORT}`);
  scheduler.register({ name: "heartbeat", schedule: SCHEDULE, task: heartbeat });
});

// 采集 cron 归这个容器所有：应用容器不再启动采集。
// 先把健康检查端口挂上，再启动采集 —— 采集起不来也要能被 healthz 看见。
try {
  await startCollectionCronIfEnabled();
} catch (error) {
  console.error("[cron] 启动采集 cron 失败：", error);
  // 采集是本容器的主职责，起不来就该让容器重启（而不是装作健康）。
  throw error;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`[cron] 收到 ${signal}，正在退出`);
    scheduler.stop();
    server.close(() => process.exit(0));
  });
}
