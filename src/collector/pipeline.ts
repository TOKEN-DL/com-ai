/**
 * 多源采集编排：**单源异常不得阻塞其他源**（spec 决策 4）。
 *
 * 一个源挂掉（网络失败 / 上游改版 / 配置写错）时：
 *   - 该源记一条失败，不抛到调用方；
 *   - 其它源照常采、照常入库。
 *
 * 这样一条源挂掉不会让整批采集白跑，也让运维看得见「哪几个源没成」。
 */
import type { FetchResult, RawItem, SourceAdapter, SourceConfig } from "@/collector/types";

export type SourceOutcome = {
  /// 采集源标识（配置级，如 "vercel-labs/skills"）。
  source: string;
  /// 适配器类型（"github-repo" …）。
  sourceType: string;
  ok: boolean;
  items: RawItem[];
  /// 失败原因（ok 为 false 时有值）。
  error?: string;
  /// 非致命问题（部分条目失败等）。
  warning?: string;
};

export type CollectReport = {
  outcomes: SourceOutcome[];
  /// 所有成功源产出的条目，按源顺序拼接。
  items: RawItem[];
  /// 失败的源数量。
  failures: number;
};

/** 一个待采集的源：适配器 + 它的配置。 */
export type SourceRequest<TConfig extends SourceConfig = SourceConfig> = {
  adapter: SourceAdapter<TConfig>;
  config: TConfig;
  /// 失败时的日志标签；默认用配置的 owner/repo 或适配器名。
  label?: string;
};

function describeSource(request: SourceRequest, adapterName: string): string {
  if (request.label) {
    return request.label;
  }
  const config = request.config as unknown as Record<string, unknown>;
  if (typeof config.owner === "string" && typeof config.repo === "string") {
    return `${config.owner}/${config.repo}`;
  }
  return adapterName;
}

/**
 * 依次采集多个源。
 *
 * **不抛错**：任何单个源的失败都被吞进 outcome 里。
 */
export async function collectFromSources(
  requests: readonly SourceRequest[],
): Promise<CollectReport> {
  const outcomes: SourceOutcome[] = [];
  const items: RawItem[] = [];

  for (const request of requests) {
    const adapterName = request.adapter.getName();
    const source = describeSource(request, adapterName);

    let result: FetchResult;
    try {
      result = await request.adapter.fetch(request.config);
    } catch (error) {
      outcomes.push({
        source,
        sourceType: adapterName,
        ok: false,
        items: [],
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    outcomes.push({
      source,
      sourceType: result.sourceType,
      ok: true,
      items: result.items,
      warning: result.error,
    });
    items.push(...result.items);
  }

  return {
    outcomes,
    items,
    failures: outcomes.filter((outcome) => !outcome.ok).length,
  };
}
