/**
 * 仓库 star 的自算（GitHub Search API，票 #13）。
 *
 * 为什么走 Search API 而不是 `GET /repos/{owner}/{repo}`：配额差一个数量级
 * （core 60 次/小时 vs search 10 次/分钟 ≈ 600 次/小时），
 * 一批几百个 MCP server 逐个查会直接打爆未认证配额。
 *
 * 实测出来的三条硬事实都钉在这里：
 *   1. `repo:` 限定符**可以并列多个**（空格分隔，语义是「或」），
 *      但 `OR` 关键字不行（GitHub 会报 422）；
 *   2. 限定符里的仓库必须存在 —— 整批都不存在时 GitHub 返 422 而不是空结果，
 *      所以这里要能拆批重查；
 *   3. 没查到的仓库**不在结果里**（不是 star=0）：「不知道」和「真的是 0 星」
 *      不是一回事。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { HttpClient } from "@/collector/http";
import { fetchRepoStats, splitRepoSlug } from "@/collector/github-stars";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "mcp-registry");

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), "utf8");
}

describe("GitHub Search API —— 批量算 star", () => {
  it("一次请求查多个仓库，限定符用空格并列（不是 OR）", async () => {
    const calls: string[] = [];
    const http: HttpClient = async (url) => {
      calls.push(url);
      return new Response(fixture("github-search-repos.json"), { status: 200 });
    };

    const stats = await fetchRepoStats(
      ["pulsemcp/mcp-servers", "frumu-ai/tandem", "modelcontextprotocol/servers"],
      { http, delayMs: 0, sleep: async () => {} },
    );

    expect(calls).toHaveLength(1);
    const query = decodeURIComponent(new URL(calls[0]!).searchParams.get("q") ?? "");
    expect(query).toBe(
      "repo:pulsemcp/mcp-servers repo:frumu-ai/tandem repo:modelcontextprotocol/servers",
    );
    // `OR` 会被 GitHub 拒（422），所以不能用。
    expect(query).not.toContain("OR");

    expect(stats.get("pulsemcp/mcp-servers")?.stars).toBe(81);
    expect(stats.get("frumu-ai/tandem")?.stars).toBe(125);
    expect(stats.get("modelcontextprotocol/servers")?.stars).toBe(91817);
    // 仓库最近推送时间也一起拿到（详情页要显示「最近更新日期」）。
    expect(stats.get("pulsemcp/mcp-servers")?.pushedAt).toEqual(
      new Date("2026-10-09T17:32:15Z"),
    );
  });

  it("没查到的仓库不在结果里（不是 0 星）", async () => {
    const http: HttpClient = async () =>
      new Response(fixture("github-search-repos.json"), { status: 200 });

    const stats = await fetchRepoStats(
      ["pulsemcp/mcp-servers", "does/not-exist-at-all"],
      { http, delayMs: 0, sleep: async () => {} },
    );

    expect(stats.has("pulsemcp/mcp-servers")).toBe(true);
    expect(stats.has("does/not-exist-at-all")).toBe(false);
  });

  it("整批返回 422 时拆成小批重查，不让一个坏仓库拖垮整批", async () => {
    const calls: string[] = [];
    const http: HttpClient = async (url) => {
      calls.push(url);
      const query = decodeURIComponent(new URL(url).searchParams.get("q") ?? "");
      // 整批（两个限定符）时 GitHub 返 422，拆开单查就正常。
      if (query.split("repo:").length > 2) {
        return new Response('{"message":"Validation Failed"}', { status: 422 });
      }
      return new Response(fixture("github-search-repos.json"), { status: 200 });
    };

    const stats = await fetchRepoStats(["pulsemcp/mcp-servers", "frumu-ai/tandem"], {
      http,
      delayMs: 0,
      sleep: async () => {},
    });

    expect(calls.length).toBeGreaterThan(1);
    expect(stats.get("pulsemcp/mcp-servers")?.stars).toBe(81);
  });

  it("批次之间按配额配速（未认证时 Search API 是 10 次/分钟）", async () => {
    const sleeps: number[] = [];
    const http: HttpClient = async () =>
      new Response(fixture("github-search-repos.json"), { status: 200 });

    await fetchRepoStats(
      ["a/1", "a/2", "a/3", "a/4", "a/5", "a/6"],
      {
        http,
        batchSize: 2,
        token: null,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    );

    // 三批 → 两段等待。
    expect(sleeps).toHaveLength(2);
    expect(sleeps.every((ms) => ms > 0)).toBe(true);
  });

  it("格式不对的仓库名直接被丢掉，不发请求", async () => {
    const calls: string[] = [];
    const http: HttpClient = async (url) => {
      calls.push(url);
      return new Response(fixture("github-search-repos.json"), { status: 200 });
    };

    await fetchRepoStats(["not-a-slug", "a/b/c"], {
      http,
      delayMs: 0,
      sleep: async () => {},
    });

    expect(calls).toHaveLength(0);
  });

  it("仓库 slug 的拆分", () => {
    expect(splitRepoSlug("pulsemcp/mcp-servers")).toEqual({
      owner: "pulsemcp",
      repo: "mcp-servers",
    });
    expect(splitRepoSlug("nope")).toBeNull();
    expect(splitRepoSlug("a/b/c")).toBeNull();
  });
});
