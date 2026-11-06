/**
 * Seam 1 —— 采集边界（主 seam，票 #6）。
 *
 * skills.sh 是**目录来源**：它告诉我们「有哪些 skill、来自哪个仓库、热��多少」，
 * 正文仍然回源 GitHub 拿原始 SKILL.md。这里用录制的 fixture（真实首页 SSR 载荷
 * 与真实 sitemap）驱动，一个网络请求都不打。
 *
 * 三类 fixture 覆盖：
 *   1. 正常条目   —— home-leaderboard.html（真实 RSC 转义形态）/ sitemap-skills-*.xml
 *   2. 字段缺失   —— 榜单条目缺 isOfficial / sitemap 条目缺安装量
 *   3. 结构变更   —— home-changed-shape.html（字段改名）/ sitemap-changed-shape.xml（loc 形状变了）
 *
 * ⚠️ 结构变更必须**显式抛错**（SourceStructureError），不能静默返回空数组 ——
 *    否则上游改版时采集器会安静地采到 0 条，看不出是「没数据」还是「解析炸了」。
 *
 * 合规：只访问 skills.sh 的**公开页面路径**（首页 + sitemap）。
 *    `/api/search` 与 `/api/v1/*` 被 robots.txt 明确 Disallow，本文件与实现都不碰。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SourceStructureError } from "@/collector/errors";
import { SkillsShAdapter } from "@/collector/skills-sh";
import type { HttpClient } from "@/collector/http";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "skills-sh");

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), "utf8");
}

/** 打桩的 HTTP 客户端：按 URL 路由到 fixture。记录调用过的 URL。 */
function createStubHttp(
  routes: { match: (url: string) => boolean; body: (url: string) => string }[],
): { http: HttpClient; calls: string[] } {
  const calls: string[] = [];

  const http: HttpClient = async (url) => {
    calls.push(url);
    const route = routes.find((candidate) => candidate.match(url));
    if (!route) {
      throw new Error(`fixture 未覆盖这个 URL：${url}`);
    }
    return new Response(route.body(url), { status: 200 });
  };

  return { http, calls };
}

const HOME = "https://www.skills.sh/";
const SITEMAP_1 = "https://www.skills.sh/sitemap-skills-1.xml";
const SITEMAP_2 = "https://www.skills.sh/sitemap-skills-2.xml";

function leaderboardRoutes(overrides: { home?: string } = {}) {
  return [
    {
      match: (url: string) => url === HOME,
      body: () => overrides.home ?? fixture("home-leaderboard.html"),
    },
  ];
}

function sitemapRoutes(overrides: { one?: string; two?: string } = {}) {
  return [
    {
      match: (url: string) => url === SITEMAP_1,
      body: () => overrides.one ?? fixture("sitemap-skills-1.xml"),
    },
    {
      match: (url: string) => url === SITEMAP_2,
      body: () => overrides.two ?? fixture("sitemap-skills-2.xml"),
    },
  ];
}

describe("skills.sh 目录适配器 —— 榜单首页", () => {
  it("解析出每条榜单项的仓库、skillId、安装量与 8 周趋势", async () => {
    const { http } = createStubHttp(leaderboardRoutes());
    const adapter = new SkillsShAdapter({ http });

    const result = await adapter.fetch({ type: "skills-sh", catalog: "leaderboard" });

    expect(result.sourceType).toBe("skills-sh");

    const findSkills = result.items.find((item) => item.title === "find-skills");
    expect(findSkills).toBeDefined();
    expect(findSkills?.metadata.repoOwner).toBe("vercel-labs");
    expect(findSkills?.metadata.repoName).toBe("skills");
    expect(findSkills?.metadata.skillId).toBe("find-skills");
    expect(findSkills?.metadata.installs).toBe(4228408);
    expect(findSkills?.metadata.weeklyInstalls).toEqual([
      101317, 105144, 103601, 107199, 110524, 121189, 121665, 115285,
    ]);
    expect(findSkills?.metadata.isOfficial).toBe(true);
    expect(findSkills?.url).toBe("https://www.skills.sh/vercel-labs/skills/find-skills");
  });

  it("isOfficial 缺失时按 false 处理，其余字段照常", async () => {
    const { http } = createStubHttp(leaderboardRoutes());
    const adapter = new SkillsShAdapter({ http });

    const result = await adapter.fetch({ type: "skills-sh", catalog: "leaderboard" });

    const grillMe = result.items.find((item) => item.title === "grill-me");
    expect(grillMe?.metadata.isOfficial).toBe(false);
    expect(grillMe?.metadata.installs).toBe(1503864);
  });

  it("榜单里的非 GitHub 来源（域名）被跳过并记进 error，不当成条目", async () => {
    // 真实载荷里的引号是被转义的（`\"`），这里照原样构造。
    const payload = [
      '{"source":"uizze.sh","skillId":"x","name":"x","installs":1,"weeklyInstalls":[1,1,1,1,1,1,1,1]}',
      '{"source":"vercel-labs/skills","skillId":"find-skills","name":"find-skills","installs":4228408,"weeklyInstalls":[101317,105144,103601,107199,110524,121189,121665,115285],"isOfficial":true}',
    ].join(",");
    const home =
      '<!DOCTYPE html><html><body><script>self.__next_f.push([1,"53:[\\"$\\",null,' +
      `{${'"initialSkills"'.replace(/"/g, '\\"')}:[${payload.replace(/"/g, '\\"')}]}` +
      '"])</script></body></html>';

    const { http } = createStubHttp(leaderboardRoutes({ home }));
    const adapter = new SkillsShAdapter({ http });

    const result = await adapter.fetch({ type: "skills-sh", catalog: "leaderboard" });

    expect(result.items).toHaveLength(1);
    expect(result.items.some((item) => item.metadata.repoOwner === "uizze.sh")).toBe(false);
    expect(result.error).toMatch(/uizze\.sh/);
  });
});

describe("skills.sh 目录适配器 —— sitemap", () => {
  it("从 sitemap 的 URL 里解析出 owner/repo/skillId", async () => {
    const { http } = createStubHttp(sitemapRoutes());
    const adapter = new SkillsShAdapter({ http });

    const result = await adapter.fetch({ type: "skills-sh", catalog: "sitemap" });

    const first = result.items.find((item) => item.metadata.repoOwner === "vercel-labs");
    expect(first).toBeDefined();
    expect(first?.metadata.repoName).toBe("skills");
    expect(first?.metadata.skillId).toBe("find-skills");
    expect(first?.url).toBe("https://www.skills.sh/vercel-labs/skills/find-skills");
  });

  it("两个 sitemap 分片都被读到", async () => {
    const { http, calls } = createStubHttp(sitemapRoutes());
    const adapter = new SkillsShAdapter({ http });

    await adapter.fetch({ type: "skills-sh", catalog: "sitemap" });

    expect(calls).toContain(SITEMAP_1);
    expect(calls).toContain(SITEMAP_2);
  });

  it("sitemap 条目没有安装量：installs 为 0，weeklyInstalls 为空", async () => {
    const { http } = createStubHttp(sitemapRoutes());
    const adapter = new SkillsShAdapter({ http });

    const result = await adapter.fetch({ type: "skills-sh", catalog: "sitemap" });

    expect(result.items.every((item) => item.metadata.installs === 0)).toBe(true);
    expect(result.items.every((item) => (item.metadata.weeklyInstalls ?? []).length === 0)).toBe(true);
  });
});

describe("skills.sh 目录适配器 —— 结构变更必须显式失败", () => {
  it("首页载荷里的字段改名了：抛 SourceStructureError，不返回空条目", async () => {
    const { http } = createStubHttp(
      leaderboardRoutes({ home: fixture("home-missing-fields.html") }),
    );
    const adapter = new SkillsShAdapter({ http });

    await expect(
      adapter.fetch({ type: "skills-sh", catalog: "leaderboard" }),
    ).rejects.toBeInstanceOf(SourceStructureError);
  });

  it("首页载荷的键改名了（锚点没了）：抛 SourceStructureError", async () => {
    const { http } = createStubHttp(
      leaderboardRoutes({ home: fixture("home-changed-shape.html") }),
    );
    const adapter = new SkillsShAdapter({ http });

    await expect(
      adapter.fetch({ type: "skills-sh", catalog: "leaderboard" }),
    ).rejects.toBeInstanceOf(SourceStructureError);
  });

  it("sitemap 的 loc 不再是 skill URL：抛 SourceStructureError", async () => {
    const { http } = createStubHttp(
      sitemapRoutes({ one: fixture("sitemap-changed-shape.xml"), two: "" }),
    );
    const adapter = new SkillsShAdapter({ http });

    await expect(
      adapter.fetch({ type: "skills-sh", catalog: "sitemap" }),
    ).rejects.toBeInstanceOf(SourceStructureError);
  });

  it("首页里根本找不到榜单载荷：抛 SourceStructureError", async () => {
    const { http } = createStubHttp(
      leaderboardRoutes({ home: "<!DOCTYPE html><html><body>404</body></html>" }),
    );
    const adapter = new SkillsShAdapter({ http });

    await expect(
      adapter.fetch({ type: "skills-sh", catalog: "leaderboard" }),
    ).rejects.toBeInstanceOf(SourceStructureError);
  });
});

describe("skills.sh 目录适配器 —— 合规与配置", () => {
  it("只请求公开页面路径，不碰 robots 禁止的接口路径", async () => {
    const { http, calls } = createStubHttp([...leaderboardRoutes(), ...sitemapRoutes()]);
    const adapter = new SkillsShAdapter({ http });

    await adapter.fetch({ type: "skills-sh", catalog: "leaderboard" });
    await adapter.fetch({ type: "skills-sh", catalog: "sitemap" });

    expect(calls.every((url) => !url.includes("/api/"))).toBe(true);
    expect(calls.every((url) => url.startsWith("https://www.skills.sh/"))).toBe(true);
  });

  it("配置校验：catalog 必须是 leaderboard 或 sitemap", () => {
    const adapter = new SkillsShAdapter({ http: createStubHttp([]).http });

    expect(adapter.validateConfig({ type: "skills-sh", catalog: "leaderboard" })).toBe(true);
    expect(adapter.validateConfig({ type: "skills-sh", catalog: "sitemap" })).toBe(true);
    expect(
      adapter.validateConfig({ type: "skills-sh", catalog: "whatever" as "sitemap" }),
    ).toBe(false);
  });

  it("配置不合法时直接抛错，不发请求", async () => {
    const { http, calls } = createStubHttp([]);
    const adapter = new SkillsShAdapter({ http });

    await expect(
      adapter.fetch({ type: "skills-sh", catalog: "nope" as "sitemap" }),
    ).rejects.toThrow(/catalog/i);
    expect(calls).toHaveLength(0);
  });
});
