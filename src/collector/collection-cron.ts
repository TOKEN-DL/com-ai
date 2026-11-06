/**
 * 采集 cron 的启动（票 #6）。
 *
 * 单独一个模块，是为了让 `src/instrumentation.ts` 保持「薄壳」：
 * 采集管道依赖 node-cron、文件系统缓存与 Prisma，全是 **Node 运行时**的东西，
 * 不该被 Next.js 的 Edge 运行时打进包里。
 */
import { runCollectionTask } from "@/collector/collection-run";
import { buildCollectionTasks } from "@/collector/collection-tasks";
import { createScheduler, type Scheduler } from "@/worker/scheduler";

let scheduler: Scheduler | null = null;

/**
 * 启动采集 cron：每个数据源一条**独立 cron**（spec 决策 4）。
 *
 * 幂等：重复调用不会注册两遍。
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
        const outcome = await runCollectionTask({
          source: definition.id,
          sourceType: definition.sourceType,
          task: definition.task,
        });
        console.log(
          `[collector] ${definition.id}：${outcome.status}，采到 ${outcome.fetched} 条，入库 ${outcome.written} 条，失败 ${outcome.failed} 条`,
        );
      },
    });
  }
}

/** 当前调度器的状态快照（测试与运维查看用）。 */
export function collectionCronStatus(): ReturnType<Scheduler["status"]> {
  return scheduler?.status() ?? [];
}
