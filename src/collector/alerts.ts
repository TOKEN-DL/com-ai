/**
 * 采集告警与健康状态（票 #6「采集失败告警」）。
 *
 * ⚠️ 为什么不做实时通知（邮件 / 钉钉 / 企微 / 飞书）：
 *    本机**没有配任何一种凭据**（没有 SMTP、没有 webhook token），
 *    硬接一个需要凭据的通道只会得到一个「看起来有、实际永远不响」的告警。
 *    所以这里落地的是三件**不依赖凭据**的事：
 *      1. **结构化日志** —— 告警以一行 JSON 打到 stderr，容器日志一收就是；
 *      2. **告警落库** —— `CollectionAlert` 表留痕，可查、可追；
 *      3. **健康状态端点** —— `/api/collector/health` 把每个源的最近一次运行、
 *         连续失败次数、未处理告警数暴露出来，运维一眼能看到谁挂了。
 *
 * 将来要接外部通道时，在 {@link recordAlert} 里加一个投递器即可，
 * 判定逻辑（何时告警）不用改。
 */
import type { CollectionAlert, CollectionRunStatus } from "@prisma/client";

import { prisma } from "@/lib/prisma";

/** 连续失败多少次算「这个源出问题了」。 */
export const DEFAULT_FAILURE_THRESHOLD = 3;

export type AlertInput = {
  /// 出问题的采集源标识。
  source: string;
  /// 告警级别。
  severity: "WARNING" | "ERROR";
  /// 一句话说清出了什么事。
  message: string;
  /// 细节（错误信息 / 结构差异说明）。
  detail?: string | null;
  /// 触发时的连续失败次数。
  occurrences?: number;
};

/**
 * 记一条告警：落库 + 打一行结构化日志。
 *
 * **去重**：同一个源、同一级别的未确认告警只留一条，重复触发时更新
 * 次数与细节。这样每天跑一次的任务不会把告警表堆成山，
 * 而 `occurrences` 仍然如实反映「连续失败了几次」。
 *
 * 日志格式是**一行 JSON**，方便容器日志采集侧直接解析。
 */
export async function recordAlert(input: AlertInput): Promise<CollectionAlert> {
  const existing = await prisma.collectionAlert.findFirst({
    where: { source: input.source, severity: input.severity, acknowledgedAt: null },
    orderBy: { createdAt: "desc" },
  });

  const occurrences = Math.max(existing?.occurrences ?? 0, input.occurrences ?? 1);

  const alert = existing
    ? await prisma.collectionAlert.update({
        where: { id: existing.id },
        data: {
          message: input.message,
          detail: input.detail ?? null,
          occurrences,
        },
      })
    : await prisma.collectionAlert.create({
        data: {
          source: input.source,
          severity: input.severity,
          message: input.message,
          detail: input.detail ?? null,
          occurrences,
        },
      });

  const line = JSON.stringify({
    level: input.severity === "ERROR" ? "error" : "warn",
    kind: "collector-alert",
    source: input.source,
    severity: input.severity,
    message: input.message,
    detail: input.detail ?? null,
    occurrences,
    alertId: alert.id,
    at: alert.createdAt.toISOString(),
  });
  console.error(line);

  return alert;
}

/**
 * 某源**连续失败**的次数。
 *
 * 从最近一次运行往前数，连续 `FAILED` 才算；
 * 中间只要有一次不是 `FAILED`（OK / PARTIAL），连续就断了 —— 源恢复了就不该再报。
 */
export async function countConsecutiveFailures(
  source: string,
  limit = DEFAULT_FAILURE_THRESHOLD * 3,
): Promise<number> {
  const runs = await prisma.collectionRun.findMany({
    where: { source },
    orderBy: { startedAt: "desc" },
    take: limit,
    select: { status: true },
  });

  let consecutive = 0;
  for (const run of runs) {
    if (run.status === "FAILED") {
      consecutive += 1;
      continue;
    }
    break;
  }
  return consecutive;
}

export type SourceHealth = {
  source: string;
  /// 最近一次运行的开始时间。
  lastRunAt: string | null;
  /// 最近一次运行的结果。
  lastStatus: CollectionRunStatus | null;
  /// 最近一次运行的错误摘要。
  lastError: string | null;
  /// 连续失败次数。
  consecutiveFailures: number;
  /// 未确认的告警数。
  openAlerts: number;
};

export type CollectionHealth = {
  /**
   * - `ok`：所有源正常；
   * - `degraded`：有源最近失败过，但还能用；
   * - `error`：有源连续失败达到阈值。
   */
  status: "ok" | "degraded" | "error";
  sources: SourceHealth[];
  /// 未确认告警总数。
  openAlerts: number;
  /// 连续失败告警阈值。
  threshold: number;
};

/** 采集健康状态：每个源最近一次运行、连续失败次数、未处理告警。 */
export async function getCollectionHealth(
  options: { threshold?: number } = {},
): Promise<CollectionHealth> {
  const threshold = options.threshold ?? DEFAULT_FAILURE_THRESHOLD;

  const [runs, alerts] = await Promise.all([
    prisma.collectionRun.findMany({
      orderBy: { startedAt: "desc" },
      select: {
        source: true,
        status: true,
        error: true,
        startedAt: true,
        finishedAt: true,
      },
    }),
    prisma.collectionAlert.findMany({
      where: { acknowledgedAt: null },
      select: { source: true, severity: true },
    }),
  ]);

  // 一次遍历算出「每个源最近一次运行」与「连续失败次数」：
  // runs 已按时间倒序，所以每个源的**前导** FAILED 串就是它的连续失败次数。
  const latest = new Map<string, (typeof runs)[number]>();
  const streaks = new Map<string, number>();
  const broken = new Set<string>();

  for (const run of runs) {
    if (!latest.has(run.source)) {
      latest.set(run.source, run);
    }
    if (broken.has(run.source)) {
      continue; // 连续段已经被一次非 FAILED 的运行打断。
    }
    if (run.status === "FAILED") {
      streaks.set(run.source, (streaks.get(run.source) ?? 0) + 1);
    } else {
      broken.add(run.source);
      streaks.set(run.source, 0);
    }
  }

  const sources: SourceHealth[] = [...latest.values()].map((run) => ({
    source: run.source,
    lastRunAt: run.startedAt.toISOString(),
    lastStatus: run.status,
    lastError: run.error,
    consecutiveFailures: streaks.get(run.source) ?? 0,
    openAlerts: alerts.filter((alert) => alert.source === run.source).length,
  }));

  const openAlerts = alerts.length;
  const hasErrorAlert = alerts.some((alert) => alert.severity === "ERROR");
  const maxConsecutive = sources.reduce(
    (max, entry) => Math.max(max, entry.consecutiveFailures),
    0,
  );

  const status: CollectionHealth["status"] =
    hasErrorAlert || maxConsecutive >= threshold
      ? "error"
      : openAlerts > 0 || maxConsecutive > 0
        ? "degraded"
        : "ok";

  return { status, sources, openAlerts, threshold };
}
