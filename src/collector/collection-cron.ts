/**
 * 采集 cron 的启动（票 #6）。
 *
 * **谁调用它**：定时任务容器（`src/worker/index.ts`）。采集调度的**唯一归属**
 * 是这个容器 —— 应用容器不碰采集（多副本会重复采集，且和请求服务抢资源）。
 *
 * 单独一个模块，是为了让定时任务容器保持「薄壳」：采集管道依赖 node-cron、
 * 文件系统缓存与 Prisma，全是 **Node 运行时**的东西，不该被 Edge 运行时打包。
 *
 * 这一层是**中立的**：它不关心谁调用它，只负责「按源注册 cron + 跑采集」。
 * 单飞保护（advisory lock）也在这里接上：即使定时任务容器被扩到多副本，
 * 同一个采集源也只有一个实例真的采集。
 */
import { runCollectionTask } from "@/collector/collection-run";
import { buildCollectionTasks } from "@/collector/collection-tasks";
import { withCollectionLock } from "@/collector/collection-lock";
import { createScheduler, type Scheduler } from "@/worker/scheduler";

let scheduler: Scheduler | null = null;

/**
 * 启动采集 cron：每个数据源一条**独立 cron**（spec 决策 4）。
 *
 * 幂等：重复调用不会注册两遍。
 *
 * 每个任务跑之前先拿**单飞锁**（Postgres advisory lock）：
 * 拿不到就跳过本轮并记一行日志 —— 定时任务容器被扩到多副本时，
 * 同一时刻只有一个实例真的采集这个源，不会重复回源、重复入库。
 */
export async function startCollectionCron(): Promise<void> {
  if (scheduler) {
    return;
  }
  scheduler = createScheduler();

  for (const definition of buildCollectionTasks()) {
    scheduler.register({
      name: definition.id,
      schedule: definition.schedule,
      task: async () => {
        await withCollectionLock({ source: definition.id }, async () => {
          const outcome = await runCollectionTask({
            source: definition.id,
            sourceType: definition.sourceType,
            task: definition.task,
          });
          console.log(
            `[collector] ${definition.id}：${outcome.status}，采到 ${outcome.fetched} 条，入库 ${outcome.written} 条，失败 ${outcome.failed} 条`,
          );
        });
      },
    });
  }
}

/** 当前调度器的状态快照（测试与运维查看用）。 */
export function collectionCronStatus(): ReturnType<Scheduler["status"]> {
  return scheduler?.status() ?? [];
}
