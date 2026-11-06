/**
 * 定时任务容器入口。
 *
 * #2 只交付「调度骨架」：容器能起来、能连上 Postgres、能按 cron 表达式触发任务、
 * 有可被容器 healthcheck 探测的 /healthz。真正的采集管道（#6）与简介生成
 * （#7）接入时在这里注册各自的独立 cron —— spec 要求**每个数据源独立 cron**，
 * 而不是统一轮询。
 *
 * 不用 Prisma：这里只做「能不能连上库」的心跳，用 pg 直连更轻，
 * 也让本容器不依赖 Node 引擎产物，能被打成单文件。
 */
import { createServer } from "node:http";

import cron from "node-cron";
import { Pool } from "pg";

const PORT = Number(process.env.WORKER_PORT ?? 3001);
const SCHEDULE = process.env.CRON_SCHEDULE ?? "0 * * * *";
const DATABASE_URL = process.env.DATABASE_URL ?? "";

type JobState = {
  name: string;
  schedule: string;
  lastRunAt: string | null;
  lastRunOk: boolean | null;
  runs: number;
};

const jobs: JobState[] = [];

function log(message: string): void {
  console.log(`[cron] ${new Date().toISOString()} ${message}`);
}

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

function registerJob(name: string, schedule: string, task: () => Promise<void>): void {
  const state: JobState = {
    name,
    schedule,
    lastRunAt: null,
    lastRunOk: null,
    runs: 0,
  };
  jobs.push(state);

  cron.schedule(
    schedule,
    () => {
      void (async () => {
        state.runs += 1;
        try {
          await task();
          state.lastRunOk = true;
          state.lastRunAt = new Date().toISOString();
          log(`任务 ${name} 执行成功`);
        } catch (error) {
          state.lastRunOk = false;
          state.lastRunAt = new Date().toISOString();
          log(`任务 ${name} 执行失败：${error instanceof Error ? error.message : String(error)}`);
        }
      })();
    },
    { timezone: "Asia/Shanghai" },
  );

  log(`已注册任务 ${name}，cron = ${schedule}`);
}

const server = createServer((req, res) => {
  if (req.url !== "/healthz") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      status: "ok",
      schedule: SCHEDULE,
      jobs,
    }),
  );
});

server.listen(PORT, "0.0.0.0", () => {
  log(`定时任务容器已启动，健康检查端口 ${PORT}`);
  registerJob("heartbeat", SCHEDULE, heartbeat);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log(`收到 ${signal}，正在退出`);
    server.close(() => process.exit(0));
  });
}
