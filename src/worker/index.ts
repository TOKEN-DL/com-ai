/**
 * 定时任务容器入口。
 *
 * #2 交付了「调度骨架」：容器能起来、能连上 Postgres、能按 cron 表达式触发任务、
 * 有可被容器 healthcheck 探测的 /healthz。#6 在这个骨架上接入**采集管道**：
 * 每个数据源一条**独立 cron**（高频源与低频源节奏不同，不做统一轮询）。
 *
 * ⚠️ 为什么采集的**入库**不在这个容器里跑：
 *    定时任务容器的镜像里只有打包产物 `dist/worker.mjs`，**没有 node_modules**，
 *    所以 Prisma 的查询引擎跑不起来；而入库必须走唯一写入路径
 *    `src/lib/asset-writer.ts`（Prisma）。因此采集 cron 由**应用容器**执行
 *    （`src/app/instrumentation.ts`），调度器实现仍然只有这一份
 *    （`src/worker/scheduler.ts`），两边共用。
 *    要把采集搬回这个容器，需要改 Dockerfile 把 node_modules 拷进去（本次不动）。
 *
 * 不用 Prisma：这里只做「能不能连上库」的心跳，用 pg 直连更轻，
 * 也让本容器不依赖 Node 引擎产物，能被打成单文件。
 */
import { createServer } from "node:http";

import { Pool } from "pg";

import { createScheduler } from "@/worker/scheduler";

const PORT = Number(process.env.WORKER_PORT ?? 3001);
const SCHEDULE = process.env.CRON_SCHEDULE ?? "0 * * * *";
const DATABASE_URL = process.env.DATABASE_URL ?? "";

const scheduler = createScheduler();

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
        collection,
      }),
    );
  })();
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[cron] 定时任务容器已启动，健康检查端口 ${PORT}`);
  scheduler.register({ name: "heartbeat", schedule: SCHEDULE, task: heartbeat });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`[cron] 收到 ${signal}，正在退出`);
    scheduler.stop();
    server.close(() => process.exit(0));
  });
}
