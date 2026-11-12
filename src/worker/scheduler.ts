/**
 * 定时任务调度器（票 #6）。
 *
 * 抄 `TOKEN-DL/DL-monitor` 的 `server/monitor/scheduler.js`：
 * **每个数据源独立 cron**（高频源与低频源节奏不同，不做统一轮询），
 * 每个任务带自己的时区，任务状态可查。
 *
 * 这里是**唯一**的调度器实现：定时任务容器（`src/worker/index.ts`）与
 * 应用容器（`src/app/instrumentation.ts`）都用它，不存在第二套 cron 逻辑。
 *
 * ⚠️ node-cron v4 是 **ESM-first** 的包，内部用 `import.meta.url` 定位自己的
 *    daemon.js。esbuild 产物必须保持 ESM（打成 CJS 会让 import.meta.url 变 undefined）。
 *    用 `forkProcess: false`（默认），daemon 路径不会被用到。
 */
import cron, { type ScheduledTask } from "node-cron";

/** 默认时区：采集节奏按中国标准时间排。 */
export const DEFAULT_TIMEZONE = "Asia/Shanghai";

export type ScheduledJob = {
  /// 任务名（用于状态与日志）。
  name: string;
  /// cron 表达式。
  schedule: string;
  /// 任务干什么。抛错只记状态，不会让调度器挂掉。
  task: () => Promise<void>;
  /// 覆盖默认时区。
  timezone?: string;
  /// 启动后立刻跑一次。
  runOnStart?: boolean;
};

export type JobState = {
  name: string;
  schedule: string;
  timezone: string;
  /// 最近一次运行时间。
  lastRunAt: string | null;
  /// 最近一次运行是否成功。
  lastRunOk: boolean | null;
  /// 最近一次失败的原因。
  lastError: string | null;
  /// 累计运行次数。
  runs: number;
  /// 累计失败次数。
  failures: number;
};

export type SchedulerOptions = {
  /// 默认时区。
  timezone?: string;
  /** 日志出口（默认 console.log）。 */
  log?: (message: string) => void;
};

export type Scheduler = {
  /** 注册一个任务。 */
  register(job: ScheduledJob): void;
  /** 立刻跑一次某个任务（不等 cron）。运维手动触发与测试都用它。 */
  runNow(name: string): Promise<void>;
  /** 停掉所有任务。 */
  stop(): void;
  /** 所有任务的状态快照。 */
  status(): JobState[];
};

/**
 * 造一个调度器。
 *
 * 任务之间**互不阻塞**：一个任务抛错只影响它自己的状态。
 */
export function createScheduler(options: SchedulerOptions = {}): Scheduler {
  const timezone = options.timezone ?? DEFAULT_TIMEZONE;
  const log = options.log ?? ((message: string) => console.log(`[cron] ${message}`));

  const states = new Map<string, JobState>();
  const tasks: ScheduledTask[] = [];
  const runners = new Map<string, () => Promise<void>>();

  const register = (job: ScheduledJob): void => {
    const state: JobState = {
      name: job.name,
      schedule: job.schedule,
      timezone: job.timezone ?? timezone,
      lastRunAt: null,
      lastRunOk: null,
      lastError: null,
      runs: 0,
      failures: 0,
    };
    states.set(job.name, state);

    const run = async (): Promise<void> => {
      state.runs += 1;
      try {
        await job.task();
        state.lastRunOk = true;
        state.lastError = null;
        state.lastRunAt = new Date().toISOString();
        log(`任务 ${job.name} 执行成功`);
      } catch (error) {
        state.lastRunOk = false;
        state.failures += 1;
        state.lastError = error instanceof Error ? error.message : String(error);
        state.lastRunAt = new Date().toISOString();
        log(`任务 ${job.name} 执行失败：${state.lastError}`);
      }
    };
    runners.set(job.name, run);

    const scheduled = cron.schedule(
      job.schedule,
      () => {
        void run();
      },
      { timezone: state.timezone },
    );
    tasks.push(scheduled);

    log(`已注册任务 ${job.name}，cron = ${job.schedule}（${state.timezone}）`);

    if (job.runOnStart) {
      setTimeout(() => {
        void run();
      }, 3_000);
    }
  };

  return {
    register,
    runNow: async (name: string): Promise<void> => {
      const runner = runners.get(name);
      if (!runner) {
        throw new Error(`没有这个任务：${name}`);
      }
      await runner();
    },
    stop: () => {
      for (const task of tasks) {
        task.stop();
      }
      tasks.length = 0;
    },
    status: () => [...states.values()],
  };
}
