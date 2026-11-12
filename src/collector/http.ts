/**
 * 采集层的 HTTP 客户端：超时 + 指数退避重试 + 限流退避 + UA 轮换。
 *
 * 抄 `TOKEN-DL/DL-monitor` 的 `server/sources/base.js` 里的 `safeFetchJSON` /
 * `safeFetchText`（15s 超时 + 3 次退避），再按实测补上 GitHub 的限流信号
 * （`X-RateLimit-Remaining: 0` + `X-RateLimit-Reset`）。
 *
 * 与原版的差别：
 *   1. 退避改成**指数**（500ms → 1s → 2s …），并设上限；
 *   2. 429 / 403(限流) 读 `Retry-After` / `X-RateLimit-Reset`，退避到服务器要求的时间；
 *   3. 4xx（除 429 / 403 限流）**不重试** —— 404 是「这个路径不存在」，重试没有意义；
 *   4. `sleep` 可注入，测试不用真的等。
 */
import { getRandomUserAgent } from "@/collector/user-agents";

/** 默认超时 15 秒（抄 DL-monitor 的 15s）。 */
export const DEFAULT_TIMEOUT_MS = 15_000;
/** 默认尝试次数：首次 + 2 次重试 = 3 次（抄 DL-monitor 的「3 次退避」）。 */
export const DEFAULT_RETRIES = 3;
/** 默认退避基数。 */
export const DEFAULT_BACKOFF_MS = 500;
/** 单次退避上限。 */
export const DEFAULT_MAX_BACKOFF_MS = 10_000;

export type HttpRequestInit = {
  headers?: Record<string, string>;
  /// 覆盖默认超时。
  timeoutMs?: number;
  /// HTTP 方法。默认 GET。
  ///
  /// MCP 的工具发现要发 JSON-RPC 的 POST，所以这里开了口；
  /// 其它采集源全是只读的 GET，不受影响。
  method?: string;
  /// 请求体（字符串）。
  body?: string;
};

export type HttpClient = (url: string, init?: HttpRequestInit) => Promise<Response>;

export type HttpClientOptions = {
  timeoutMs?: number;
  /// 首次请求之外的额外尝试次数。
  retries?: number;
  backoffMs?: number;
  maxBackoffMs?: number;
  /// 固定 UA；不给则每次请求从 UA 池里轮换一个。
  userAgent?: string;
  /// 注入退避等待（测试用）。
  sleep?: (ms: number) => Promise<void>;
};

/** HTTP 层面的失败。带状态码，便于上层区分「限流」与「不存在」。 */
export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  /// 服务端要求等待的毫秒数（Retry-After / X-RateLimit-Reset）。
  readonly retryAfterMs: number | null;

  constructor(url: string, status: number, statusText: string, retryAfterMs: number | null = null) {
    super(`HTTP ${status} ${statusText}：${url}`);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
    this.retryAfterMs = retryAfterMs;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 是不是「被限流了」。实测：未认证 60 次/小时，认证后 5000 次/小时。 */
function isRateLimited(response: Response): boolean {
  if (response.status === 429) {
    return true;
  }
  if (response.status === 403) {
    return response.headers.get("x-ratelimit-remaining") === "0";
  }
  return false;
}

/** 服务端要求等多久（毫秒）。优先 Retry-After，其次 X-RateLimit-Reset。 */
function retryDelayMs(response: Response): number | null {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return Math.max(0, seconds * 1000);
    }
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) {
      return Math.max(0, date - Date.now());
    }
  }

  const reset = response.headers.get("x-ratelimit-reset");
  if (reset) {
    const seconds = Number(reset);
    if (Number.isFinite(seconds)) {
      return Math.max(0, seconds * 1000 - Date.now());
    }
  }

  return null;
}

/** 该不该重试。 */
function isRetryable(error: unknown): boolean {
  if (error instanceof HttpError) {
    if (error.status === 429) {
      return true;
    }
    if (error.status === 403) {
      // 只有确认是限流（带退避时间）才重试；权限不足重试没有意义。
      return error.retryAfterMs !== null;
    }
    return error.status >= 500;
  }
  // 网络层错误（超时、DNS、TLS 握手抖动）都值得重试。
  return true;
}

/** 本次退避时长：指数退避与服务端要求取大者，上限 maxBackoffMs。 */
function computeDelay(
  attempt: number,
  error: unknown,
  backoffMs: number,
  maxBackoffMs: number,
): number {
  const exponential = backoffMs * 2 ** attempt;
  const hinted = error instanceof HttpError ? error.retryAfterMs : null;
  return Math.min(maxBackoffMs, Math.max(exponential, hinted ?? 0));
}

/**
 * 造一个带容错的 HTTP 客户端。
 *
 * 退避逻辑放在这里而不是各适配器里，是为了让「超时 / 重试 / 限流 / UA 轮换」
 * 这四件事只有一份实现（spec 决策 4「内置失败容错」）。
 */
export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const sleep = options.sleep ?? defaultSleep;

  return async (url, init = {}) => {
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? timeoutMs);

      try {
        const response = await fetch(url, {
          method: init.method ?? "GET",
          body: init.body,
          headers: {
            "User-Agent": options.userAgent ?? getRandomUserAgent(),
            ...(init.headers ?? {}),
          },
          signal: controller.signal,
          redirect: "follow",
        });

        if (response.ok) {
          return response;
        }

        throw new HttpError(
          url,
          response.status,
          response.statusText,
          isRateLimited(response) ? retryDelayMs(response) : null,
        );
      } catch (error) {
        lastError = error;
        if (attempt === retries || !isRetryable(error)) {
          throw error;
        }
        await sleep(computeDelay(attempt, error, backoffMs, maxBackoffMs));
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError;
  };
}

/** 取 JSON。 */
export async function fetchJson<T>(
  client: HttpClient,
  url: string,
  init?: HttpRequestInit,
): Promise<T> {
  const response = await client(url, init);
  return (await response.json()) as T;
}

/** 取文本。 */
export async function fetchText(
  client: HttpClient,
  url: string,
  init?: HttpRequestInit,
): Promise<string> {
  const response = await client(url, init);
  return await response.text();
}
