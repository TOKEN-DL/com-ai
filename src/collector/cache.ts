/**
 * 采集层的磁盘缓存（票 #6「GitHub 请求分批且带缓存」）。
 *
 * 为什么需要：
 *   - GitHub 未认证只有 **60 次/小时**，认证后 5000 次/小时（实测，见
 *     .com-ai-context/verified-endpoints.md 1.3 节）。批量采集一个仓库就要
 *     2 次 API 调用（仓库元数据 + trees），86 个仓库就是 172 次。
 *   - 每天跑一次时，同一个仓库的 trees 在一天之内**不会变**。缓存住，
 *     第二天重跑只花 raw 请求（raw 域不占 API 配额）。
 *
 * 缓存什么：
 *   - `api.github.com` 的响应（仓库元数据 + trees）—— 占 API 配额的那部分；
 *   - `raw.githubusercontent.com` 的正文 —— 不占配额，但缓存住能少打扰上游。
 *
 * 缓��在哪：默认 `.cache/collector`（已 gitignore），可用 `COLLECTOR_CACHE_DIR` 改。
 * TTL 默认 6 小时 —— 一天跑一次的任务，第二天自然全部过期重取。
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { HttpClient, HttpRequestInit } from "@/collector/http";

export const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_CACHE_DIR = ".cache/collector";

type CacheEntry = {
  url: string;
  status: number;
  body: string;
  fetchedAt: number;
};

export type CachingHttpClientOptions = {
  /// 底层客户端（通常是 {@link createHttpClient}）。
  base: HttpClient;
  /// 缓存目录。
  dir?: string;
  /// 缓存有效期（毫秒）。
  ttlMs?: number;
  /// 当前时间（测试可注入）。
  now?: () => number;
};

function cacheKey(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 32);
}

/**
 * 造一个带磁盘缓存的 HTTP 客户端。
 *
 * 只缓存 **GET + 2xx** 的响应：4xx / 5xx 不进缓存（否则一次偶发 500 会把
 * 错误响应固化一整天）。
 */
export function createCachingHttpClient(options: CachingHttpClientOptions): HttpClient {
  const base = options.base;
  const dir = options.dir ?? DEFAULT_CACHE_DIR;
  const ttlMs = options.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = options.now ?? Date.now;

  let ensured = false;
  const ensureDir = (): void => {
    if (ensured) return;
    mkdirSync(dir, { recursive: true });
    ensured = true;
  };

  return async (url: string, init?: HttpRequestInit): Promise<Response> => {
    ensureDir();
    const file = path.join(dir, `${cacheKey(url)}.json`);

    try {
      const raw = readFileSync(file, "utf8");
      const entry = JSON.parse(raw) as CacheEntry;
      if (entry.url === url && now() - entry.fetchedAt < ttlMs) {
        return new Response(entry.body, {
          status: entry.status,
          headers: { "x-com-ai-cache": "hit" },
        });
      }
    } catch {
      // 缓存缺失 / 损坏 / 过期 —— 当作没有缓存。
    }

    const response = await base(url, init);
    if (!response.ok) {
      return response;
    }

    const body = await response.text();
    try {
      const entry: CacheEntry = { url, status: response.status, body, fetchedAt: now() };
      writeFileSync(file, JSON.stringify(entry), "utf8");
    } catch {
      // 缓存写不进去不影响采集主流程。
    }

    return new Response(body, {
      status: response.status,
      headers: { "x-com-ai-cache": "miss" },
    });
  };
}
