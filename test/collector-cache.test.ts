/**
 * 采集器的 HTTP 磁盘缓存（票 #6 验收标准第 7 条「请求分批且带缓存」）。
 *
 * 这是纯函数级别的单元测试：不打网络，用假的底层客户端验证
 * 「命中 / 未命中 / 过期 / 错误不缓存」四种行为。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createCachingHttpClient } from "@/collector/cache";
import type { HttpClient } from "@/collector/http";

const dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "com-ai-cache-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("采集 HTTP 缓存", () => {
  it("第一次请求落到底层，第二次直接命中缓存", async () => {
    let calls = 0;
    const base: HttpClient = async () => {
      calls += 1;
      return new Response('{"ok":true}', { status: 200 });
    };

    const client = createCachingHttpClient({ base, dir: makeDir(), ttlMs: 60_000 });

    const first = await client("https://api.github.com/repos/acme/skills");
    expect(await first.json()).toEqual({ ok: true });
    expect(calls).toBe(1);

    const second = await client("https://api.github.com/repos/acme/skills");
    expect(await second.json()).toEqual({ ok: true });
    expect(calls).toBe(1);
    expect(second.headers.get("x-com-ai-cache")).toBe("hit");
  });

  it("不同的 URL 各缓存各的", async () => {
    let calls = 0;
    const base: HttpClient = async (url) => {
      calls += 1;
      return new Response(url, { status: 200 });
    };

    const client = createCachingHttpClient({ base, dir: makeDir(), ttlMs: 60_000 });

    await client("https://api.github.com/repos/a/one");
    await client("https://api.github.com/repos/a/two");
    await client("https://api.github.com/repos/a/one");

    expect(calls).toBe(2);
  });

  it("过了有效期就重新回源", async () => {
    let calls = 0;
    let now = 1_000;
    const base: HttpClient = async () => {
      calls += 1;
      return new Response("body", { status: 200 });
    };

    const client = createCachingHttpClient({
      base,
      dir: makeDir(),
      ttlMs: 1_000,
      now: () => now,
    });

    await client("https://api.github.com/repos/acme/skills");
    expect(calls).toBe(1);

    now += 500;
    await client("https://api.github.com/repos/acme/skills");
    expect(calls).toBe(1);

    now += 1_000; // 超过 TTL
    await client("https://api.github.com/repos/acme/skills");
    expect(calls).toBe(2);
  });

  it("错误响应不进缓存（免得把一次偶发 500 固化一整天）", async () => {
    let calls = 0;
    const base: HttpClient = async () => {
      calls += 1;
      return new Response("boom", { status: 500 });
    };

    const client = createCachingHttpClient({ base, dir: makeDir(), ttlMs: 60_000 });

    await client("https://api.github.com/repos/acme/skills");
    await client("https://api.github.com/repos/acme/skills");

    expect(calls).toBe(2);
  });
});
