/**
 * 仓库热度：**用 GitHub Search API 自算** star 数（票 #13）。
 *
 * ## 为什么走 Search API 而不是 `GET /repos/{owner}/{repo}`
 *
 * 两者拿到的都是权威 star 数，但配额天差地别（实测响应头）：
 *
 * | 接口 | 未认证 | 认证后 |
 * | --- | --- | --- |
 * | `GET /repos/{owner}/{repo}`（core） | **60 次/小时** | 5000 次/小时 |
 * | `GET /search/repositories`（search） | **10 次/分钟**（≈600 次/小时） | 30 次/分钟 |
 *
 * 一批 MCP server 有几百个条目，逐个 `GET /repos/...` 未认证直接就打爆配额。
 * Search API 的配额**按分钟**计（不是按小时），所以更扛得住批量。
 *
 * ## 批量能力（实测）
 *
 * `repo:` 限定符**可以并列多个**，语义是「或」：
 *
 *     GET /search/repositories?q=repo:a/b repo:c/d repo:e/f&per_page=100
 *
 * 实测一次查 16 个、50 个仓库都成功（q 长度 1409 字符），返回的每个仓库对象里
 * 就有 `stargazers_count` / `pushed_at` / `updated_at`。
 * ⚠️ 但 `OR` 关键字**不行**：`repo:a/b OR repo:c/d` 会报
 *    「The search contains only logical operators without any search terms」。
 *    只能靠空格并列。
 *
 * ⚠️ 还有一个坑：**限定符里的仓库必须存在**。整批都不存在时 GitHub 直接返回
 *    422（不是空结果），所以这里对 422 做**二分拆分**重试，把能查到的查回来。
 */
import { HttpError, createHttpClient, type HttpClient } from "@/collector/http";
import { readGitHubToken } from "@/collector/github";

const GITHUB_API = "https://api.github.com";

/** 一个仓库的统计信息。 */
export type RepoStats = {
  /// star 数。
  stars: number;
  /// 仓库最后一次推送的时间（null = 没取到）。
  pushedAt: Date | null;
  /// 仓库元数据的最后更新时间。
  updatedAt: Date | null;
};

export type RepoStatsOptions = {
  /// 注入 HTTP 客户端（测试用 fixture 驱动）。
  http?: HttpClient;
  /// GitHub token。不给则从环境变量读；都没有 = 未认证。
  token?: string | null;
  apiBase?: string;
  /// 一批最多查多少个仓库。实测 50 个一批没问题，取 25 留余量。
  batchSize?: number;
  /// 批次之间的等待（毫秒）。未认证时 Search API 是 10 次/分钟，
  /// 所以默认按 6.5 秒一批来配速（≈9 次/分钟）。
  delayMs?: number;
  /// 可注入的等待（测试不用真等）。
  sleep?: (ms: number) => Promise<void>;
};

/** 未认证时 Search API 的配额是 10 次/分钟 → 每批至少隔 6.5 秒。 */
const UNAUTHENTICATED_DELAY_MS = 6_500;
/** 认证后是 30 次/分钟 → 每批隔 2.1 秒。 */
const AUTHENTICATED_DELAY_MS = 2_100;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 把 `owner/repo` 拆开。格式不对返回 null。 */
export function splitRepoSlug(slug: string): { owner: string; repo: string } | null {
  const matched = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(slug.trim());
  if (!matched) {
    return null;
  }
  return { owner: matched[1], repo: matched[2] };
}

/** GitHub API 请求头。token 只发给 api.github.com。 */
function apiHeaders(token: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "com-ai-collector",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

/**
 * 查一批仓库的 star 数。
 *
 * 返回的 Map 里**没有**某个仓库 = 没查到这个仓库（不存在 / 没进搜索索引），
 * 调用方据此把 stars 留成 null（而不是 0 ——「不知道」和「真的是 0 星」不是一回事）。
 */
export async function fetchRepoStats(
  slugs: string[],
  options: RepoStatsOptions = {},
): Promise<Map<string, RepoStats>> {
  const http = options.http ?? createHttpClient();
  const token = options.token === undefined ? readGitHubToken() : options.token;
  const apiBase = options.apiBase ?? GITHUB_API;
  const batchSize = options.batchSize ?? 25;
  const delayMs =
    options.delayMs ??
    (token ? AUTHENTICATED_DELAY_MS : UNAUTHENTICATED_DELAY_MS);
  const sleep = options.sleep ?? defaultSleep;

  const valid = slugs.filter((slug) => splitRepoSlug(slug) !== null);
  const out = new Map<string, RepoStats>();

  const batches: string[][] = [];
  for (let i = 0; i < valid.length; i += batchSize) {
    batches.push(valid.slice(i, i + batchSize));
  }

  for (let i = 0; i < batches.length; i += 1) {
    if (i > 0 && delayMs > 0) {
      await sleep(delayMs);
    }
    const stats = await fetchBatch(batches[i], { http, token, apiBase });
    for (const [slug, value] of stats) {
      out.set(slug, value);
    }
  }

  return out;
}

type BatchContext = {
  http: HttpClient;
  token: string | null;
  apiBase: string;
};

/**
 * 查一批。整批返回 422 时（限定符里的仓库全都不存在）**二分拆开重查**，
 * 把还能查到的捞回来 —— 否则一个坏仓库会拖垮整批。
 */
async function fetchBatch(
  batch: string[],
  context: BatchContext,
): Promise<Map<string, RepoStats>> {
  const out = new Map<string, RepoStats>();
  if (batch.length === 0) {
    return out;
  }

  const query = batch.map((slug) => `repo:${slug}`).join(" ");
  const url = `${context.apiBase}/search/repositories?q=${encodeURIComponent(query)}&per_page=100`;

  let payload: unknown;
  try {
    const response = await context.http(url, { headers: apiHeaders(context.token) });
    payload = await response.json();
  } catch (error) {
    if (error instanceof HttpError && error.status === 422 && batch.length > 1) {
      const middle = Math.ceil(batch.length / 2);
      const first = await fetchBatch(batch.slice(0, middle), context);
      const second = await fetchBatch(batch.slice(middle), context);
      return new Map([...first, ...second]);
    }
    // 其它错误（限流 / 网络）由 HTTP 客户端重试过一轮了，还失败就当这批没查到。
    return out;
  }

  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    return out;
  }

  for (const item of payload.items) {
    if (!isRecord(item) || typeof item.full_name !== "string") {
      continue;
    }
    const stars = typeof item.stargazers_count === "number" ? item.stargazers_count : null;
    if (stars === null) {
      continue;
    }
    out.set(item.full_name.toLowerCase(), {
      stars,
      pushedAt: parseDate(item.pushed_at),
      updatedAt: parseDate(item.updated_at),
    });
  }

  return out;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
