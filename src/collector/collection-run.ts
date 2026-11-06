/**
 * 采集任务的外壳：跑任务 → 记运行 → 判连续失败 → 告警（票 #6）。
 *
 * cron 调的是这一层，不是裸的采集函数。这样每次运行都留下：
 *   - 一条 `CollectionRun`（跑没跑、采到多少、入库多少、失败原因）；
 *   - 连续失败到阈值时，一条 `CollectionAlert`（落库 + 结构化日志）。
 *
 * 任务本身**抛错也不会让整轮调度挂掉**：错误被收进运行记录，转成 `FAILED` 状态。
 */
import type { CollectionRunStatus } from "@prisma/client";

import {
  countConsecutiveFailures,
  DEFAULT_FAILURE_THRESHOLD,
  recordAlert,
} from "@/collector/alerts";
import { prisma } from "@/lib/prisma";

export type CollectionTaskResult = {
  /// 采到的条目数。
  fetched: number;
  /// 入库成功条数。
  written: number;
  /// 入库失败条数。
  failed: number;
  /// 失败的子源（仓库）数量。
  failures: number;
  /// 失败原因摘要。
  error?: string;
};

export type CollectionRunOutcome = {
  source: string;
  status: CollectionRunStatus;
  fetched: number;
  written: number;
  failed: number;
  failures: number;
  error?: string;
  durationMs: number;
  /// 是否触发了告警。
  alerted: boolean;
};

export type RunCollectionTaskOptions = {
  /// 采集源标识，如 "skills.sh:leaderboard"。
  source: string;
  /// 采集源类型，如 "skills-sh"。
  sourceType: string;
  /// 真正干活的函数。
  task: () => Promise<CollectionTaskResult>;
  /// 连续失败多少次开始告警。
  threshold?: number;
  /// 当前时间（测试可注入）。
  now?: () => Date;
};

/**
 * 跑一次采集任务，并记录运行结果 / 触发告警。
 *
 * **不抛错**：任务失败会变成一条 `FAILED` 运行记录 + （到阈值时）一条告警。
 */
export async function runCollectionTask(
  options: RunCollectionTaskOptions,
): Promise<CollectionRunOutcome> {
  const threshold = options.threshold ?? DEFAULT_FAILURE_THRESHOLD;
  const now = options.now ?? (() => new Date());
  const startedAt = now();

  let result: CollectionTaskResult;
  try {
    result = await options.task();
  } catch (error) {
    result = {
      fetched: 0,
      written: 0,
      failed: 0,
      failures: 1,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  // 整批没采到东西 = 失败；采到了一部分但有子源 / 入库失败 = 部分失败。
  const status: CollectionRunStatus =
    result.fetched === 0 && (result.error !== undefined || result.failures > 0)
      ? "FAILED"
      : result.failures > 0 || result.failed > 0
        ? "PARTIAL"
        : "OK";

  const finishedAt = now();
  const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());

  await prisma.collectionRun.create({
    data: {
      source: options.source,
      sourceType: options.sourceType,
      status,
      fetched: result.fetched,
      written: result.written,
      failed: result.failed,
      failures: result.failures,
      error: result.error ?? null,
      durationMs,
      startedAt,
      finishedAt,
    },
  });

  let alerted = false;
  if (status === "FAILED") {
    const consecutive = await countConsecutiveFailures(options.source);
    if (consecutive >= threshold) {
      await recordAlert({
        source: options.source,
        severity: "ERROR",
        message: `采集源连续 ${consecutive} 次失败`,
        detail: result.error ?? null,
        occurrences: consecutive,
      });
      alerted = true;
    }
  } else if (status === "PARTIAL") {
    // 部分失败也要有人看见：告警级别是 WARNING，且同源同级别只留一条，
    // 不会每天堆一条。
    await recordAlert({
      source: options.source,
      severity: "WARNING",
      message: `采集源部分失败：${result.failures} 个子源失败`,
      detail: result.error ?? null,
      occurrences: 1,
    });
    alerted = true;
  }

  return {
    source: options.source,
    status,
    fetched: result.fetched,
    written: result.written,
    failed: result.failed,
    failures: result.failures,
    error: result.error,
    durationMs,
    alerted,
  };
}
