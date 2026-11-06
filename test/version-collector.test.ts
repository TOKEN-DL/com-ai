/**
 * Seam 1 —— 采集边界（票 #16「版本管理与一键更新」）。
 *
 * 版本同步的上游取数走 **fixture 驱动**（录制的 GitHub API 响应），
 * **一个真实网络请求都不打**：把全局 `fetch` 换成打桩，
 * 底下仍然是采集层真实的 HTTP 客户端（超时 / 重试 / 限流退避 / UA 轮换）。
 *
 * 三类 fixture 覆盖：
 *   1. **正常条目** —— commits-normal.json / compare-normal.json；
 *   2. **字段缺失** —— commits-missing-fields.json（条目缺 sha）；
 *   3. **结构变更** —— commits-changed-shape.json（返回不再是数组）/ compare-changed-shape.json（files 不再是数组）。
 *
 * ⚠️ 结构变更必须**显式抛错**（SourceStructureError），不能静默返回空 ——
 *    「上游没有新提交」和「上游改版了」是两回事，混起来运维会误判。
 *
 * 降级路径也要有：compare 取不到（404 / 限流）时**不能整轮同步失败**，
 * 而是返回「差异不可用」，由同步服务退回提交列表。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SourceStructureError } from "@/collector/errors";
import { GitHubVersionSource } from "@/collector/github-versions";
import { createHttpClient } from "@/collector/http";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "github");

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), "utf8");
}

type Route = {
  match: (url: string) => boolean;
  body: (url: string) => string;
  status?: number;
};

/** 打桩全局 fetch：按 URL 路由到 fixture。记录调用过的 URL 与请求头。 */
function stubFetch(routes: Route[]): {
  calls: string[];
  headers: Map<string, Headers>;
} {
  const calls: string[] = [];
  const headers = new Map<string, Headers>();

  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    headers.set(url, new Headers(init?.headers ?? {}));

    const route = routes.find((candidate) => candidate.match(url));
    if (!route) {
      throw new Error(`fixture 未覆盖这个 URL：${url}`);
    }
    return new Response(route.body(url), { status: route.status ?? 200 });
  });

  return { calls, headers };
}

/** 真实的 HTTP 客户端（退避等待被注入成空操作，测试不等）。 */
function testHttp() {
  return createHttpClient({ sleep: async () => {} });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GitHub 版本取数 —— 正常条目", () => {
  it("取到 commit 列表（新提交在前）", async () => {
    const stub = stubFetch([
      {
        match: (url) => url.startsWith("https://api.github.com/repos/vercel-labs/skills/commits"),
        body: () => fixture("commits-normal.json"),
      },
    ]);

    const source = new GitHubVersionSource({ http: testHttp(), token: null });
    const commits = await source.fetchCommits({ owner: "vercel-labs", repo: "skills", perPage: 2 });

    expect(commits).toHaveLength(2);
    expect(commits[0].sha).toBe("9f1c2b7d4e5a6f708192a3b4c5d6e7f8091a2b3c");
    expect(commits[0].message).toContain("fix(find-skills)");
    expect(commits[0].authoredAt?.toISOString()).toBe("2025-11-04T09:12:44.000Z");
    expect(commits[1].sha).toBe("0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d");

    // 请求头要带 GitHub 要求的两个头。
    const requestHeaders = stub.headers.get(stub.calls[0]);
    expect(requestHeaders?.get("accept")).toBe("application/vnd.github+json");
    expect(requestHeaders?.get("x-github-api-version")).toBe("2022-11-28");
  });

  it("head commit 就是列表里的第一个", async () => {
    stubFetch([
      {
        match: (url) => url.includes("/commits"),
        body: () => fixture("commits-normal.json"),
      },
    ]);

    const source = new GitHubVersionSource({ http: testHttp(), token: null });
    const head = await source.fetchHeadCommit({ owner: "vercel-labs", repo: "skills" });

    expect(head?.sha).toBe("9f1c2b7d4e5a6f708192a3b4c5d6e7f8091a2b3c");
  });

  it("compare 拿到文件级差异", async () => {
    stubFetch([
      {
        match: (url) => url.includes("/compare/"),
        body: () => fixture("compare-normal.json"),
      },
    ]);

    const source = new GitHubVersionSource({ http: testHttp(), token: null });
    const outcome = await source.compare({
      owner: "vercel-labs",
      repo: "skills",
      base: "0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d",
      head: "9f1c2b7d4e5a6f708192a3b4c5d6e7f8091a2b3c",
    });

    expect(outcome.kind).toBe("diff");
    if (outcome.kind !== "diff") {
      return;
    }
    expect(outcome.files).toHaveLength(2);
    expect(outcome.files[0].filename).toBe("skills/find-skills/SKILL.md");
    expect(outcome.files[0].additions).toBe(18);
    expect(outcome.files[1].status).toBe("added");
    expect(outcome.commits).toHaveLength(2);
    expect(outcome.aheadBy).toBe(2);
  });

  it("raw 域取正文（token 不发给 raw）", async () => {
    const stub = stubFetch([
      {
        match: (url) => url.startsWith("https://raw.githubusercontent.com/vercel-labs/skills/"),
        body: () => "# 新版本正文\n",
      },
    ]);

    const source = new GitHubVersionSource({ http: testHttp(), token: "test-token" });
    const body = await source.fetchFileAt({
      owner: "vercel-labs",
      repo: "skills",
      ref: "9f1c2b7d4e5a6f708192a3b4c5d6e7f8091a2b3c",
      path: "skills/find-skills/SKILL.md",
    });

    expect(body).toBe("# 新版本正文\n");
    expect(stub.calls[0]).toBe(
      "https://raw.githubusercontent.com/vercel-labs/skills/9f1c2b7d4e5a6f708192a3b4c5d6e7f8091a2b3c/skills/find-skills/SKILL.md",
    );
    const requestHeaders = stub.headers.get(stub.calls[0]);
    expect(requestHeaders?.get("authorization")).toBeNull();
  });
});

describe("GitHub 版本取数 —— 字段缺失与结构变更（必须显式失败）", () => {
  it("commit 缺 sha：抛 SourceStructureError", async () => {
    stubFetch([
      {
        match: (url) => url.includes("/commits"),
        body: () => fixture("commits-missing-fields.json"),
      },
    ]);

    const source = new GitHubVersionSource({ http: testHttp(), token: null });

    await expect(
      source.fetchCommits({ owner: "vercel-labs", repo: "skills" }),
    ).rejects.toBeInstanceOf(SourceStructureError);
  });

  it("commits 接口返回的不是数组：抛 SourceStructureError", async () => {
    stubFetch([
      {
        match: (url) => url.includes("/commits"),
        body: () => fixture("commits-changed-shape.json"),
      },
    ]);

    const source = new GitHubVersionSource({ http: testHttp(), token: null });

    await expect(
      source.fetchCommits({ owner: "vercel-labs", repo: "skills" }),
    ).rejects.toBeInstanceOf(SourceStructureError);
  });

  it("compare 的 files 不再是数组：抛 SourceStructureError", async () => {
    stubFetch([
      {
        match: (url) => url.includes("/compare/"),
        body: () => fixture("compare-changed-shape.json"),
      },
    ]);

    const source = new GitHubVersionSource({ http: testHttp(), token: null });

    await expect(
      source.compare({
        owner: "vercel-labs",
        repo: "skills",
        base: "0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d",
        head: "9f1c2b7d4e5a6f708192a3b4c5d6e7f8091a2b3c",
      }),
    ).rejects.toBeInstanceOf(SourceStructureError);
  });
});

describe("GitHub 版本取数 —— 降级路径", () => {
  it("差异太大（too_large）：不抛错，退化成「领先 N 个提交」", async () => {
    stubFetch([
      {
        match: (url) => url.includes("/compare/"),
        body: () => fixture("compare-too-large.json"),
      },
    ]);

    const source = new GitHubVersionSource({ http: testHttp(), token: null });
    const outcome = await source.compare({
      owner: "vercel-labs",
      repo: "skills",
      base: "0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d",
      head: "9f1c2b7d4e5a6f708192a3b4c5d6e7f8091a2b3c",
    });

    expect(outcome.kind).toBe("too_large");
    if (outcome.kind !== "too_large") {
      return;
    }
    expect(outcome.aheadBy).toBe(428);
  });

  it("compare 返回 404：降级成「差异不可用」，不抛错", async () => {
    stubFetch([
      {
        match: (url) => url.includes("/compare/"),
        body: () => JSON.stringify({ message: "Not Found" }),
        status: 404,
      },
    ]);

    const source = new GitHubVersionSource({ http: testHttp(), token: null });
    const outcome = await source.compare({
      owner: "vercel-labs",
      repo: "skills",
      base: "0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d",
      head: "9f1c2b7d4e5a6f708192a3b4c5d6e7f8091a2b3c",
    });

    expect(outcome.kind).toBe("unavailable");
  });

  it("raw 取不到正文：返回 null（不抛错）", async () => {
    stubFetch([
      {
        match: (url) => url.startsWith("https://raw.githubusercontent.com/"),
        body: () => "404: Not Found",
        status: 404,
      },
    ]);

    const source = new GitHubVersionSource({ http: testHttp(), token: null });
    const body = await source.fetchFileAt({
      owner: "vercel-labs",
      repo: "skills",
      ref: "9f1c2b7d4e5a6f708192a3b4c5d6e7f8091a2b3c",
      path: "skills/find-skills/SKILL.md",
    });

    expect(body).toBeNull();
  });
});
