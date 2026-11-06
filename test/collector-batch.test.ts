/**
 * Seam 1 —— 采集边界（主 seam，票 #6）。
 *
 * 批量编排把两件事接起来：**目录来源（skills.sh）** 与 **内容回源（GitHub）**。
 *
 * 这里用录制的 fixture 驱动：
 *   - 目录：test/fixtures/skills-sh/home-leaderboard.html（真实 RSC 载荷）
 *   - 回源：test/fixtures/github/**（真实 GitHub API 响应 + 原始 SKILL.md）
 *
 * 断言的是**外部可观察行为**：产出的条目长什么样、贴没贴上热度、
 * 一个仓库失败会不会拖垮整批。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { collectBatch, type BatchSourceSpec } from "@/collector/batch";
import { GitHubRepoAdapter } from "@/collector/github";
import type { HttpClient } from "@/collector/http";
import { SkillsShAdapter } from "@/collector/skills-sh";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const GH_FIXTURES = path.join(ROOT, "github");
const SH_FIXTURES = path.join(ROOT, "skills-sh");

function fixture(dir: string, name: string): string {
  return readFileSync(path.join(dir, name), "utf8");
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

/**
 * 榜单里出现的 6 个仓库：
 *   vercel-labs/skills、mattpocock/skills、heygen-com/hyperframes、
 *   vercel-labs/agent-browser、flowkit-labs/skills、designed-by-ai/skills
 *
 * 这里给前两个仓库接上 fixture；其余 4 个故意**回源失败**，
 * 用来验证「单个仓库失败不阻塞整批」。
 */
function batchRoutes(): { match: (url: string) => boolean; body: (url: string) => string }[] {
  return [
    {
      match: (url: string) => url === HOME,
      body: () => fixture(SH_FIXTURES, "home-leaderboard.html"),
    },
    {
      match: (url: string) => url === "https://api.github.com/repos/vercel-labs/skills",
      body: () => fixture(GH_FIXTURES, "repo-vercel-labs-skills.json"),
    },
    {
      match: (url: string) =>
        url.startsWith("https://api.github.com/repos/vercel-labs/skills/git/trees/"),
      body: () => fixture(GH_FIXTURES, "tree-vercel-labs-skills.json"),
    },
    {
      match: (url: string) => url.startsWith("https://raw.githubusercontent.com/vercel-labs/skills/"),
      body: (url: string) => {
        const rawPath = url.replace("https://raw.githubusercontent.com/vercel-labs/skills/main/", "");
        const files: Record<string, string> = {
          "skills/find-skills/SKILL.md": "skill-find-skills.md",
          ".automations/pr-labeling/skills/pr-labeling/SKILL.md": "skill-vercel-pr-labeling-automations.md",
          ".automations/triage/skills/triage/SKILL.md": "skill-vercel-triage-automations.md",
          ".vc/automations/workflows/pr-labeling/skills/pr-labeling/SKILL.md": "skill-vercel-pr-labeling-vc.md",
          ".vc/automations/workflows/workflows/SKILL.md": "skill-vercel-triage-vc.md",
        };
        const file = files[rawPath];
        if (!file) {
          throw new Error(`fixture 未覆盖这个 raw 路径：${rawPath}`);
        }
        return fixture(GH_FIXTURES, file);
      },
    },
    {
      match: (url: string) => url === "https://api.github.com/repos/mattpocock/skills",
      body: () => fixture(GH_FIXTURES, "repo-batch-demo.json"),
    },
    {
      match: (url: string) =>
        url.startsWith("https://api.github.com/repos/mattpocock/skills/git/trees/"),
      body: () => fixture(GH_FIXTURES, "tree-batch-demo.json"),
    },
    {
      match: (url: string) => url.startsWith("https://raw.githubusercontent.com/mattpocock/skills/"),
      body: (url: string) => {
        const rawPath = url.replace("https://raw.githubusercontent.com/mattpocock/skills/main/", "");
        if (rawPath === "skills/grill-me/SKILL.md") {
          return fixture(GH_FIXTURES, "skill-batch-grill-me.md");
        }
        if (rawPath === "skills/unlisted-extra/SKILL.md") {
          return fixture(GH_FIXTURES, "skill-batch-unlisted-extra.md");
        }
        throw new Error(`fixture 未覆盖这个 raw 路径：${rawPath}`);
      },
    },
  ];
}

function leaderboardSource(http: HttpClient): BatchSourceSpec {
  return {
    id: "skills.sh:leaderboard",
    adapter: new SkillsShAdapter({ http }),
    config: { type: "skills-sh", catalog: "leaderboard" },
  };
}

describe("批量编排 —— 目录与回源接起来", () => {
  it("目录里的安装量、趋势与官方标记贴回回源后的条目", async () => {
    const { http } = createStubHttp(batchRoutes());

    const report = await collectBatch({
      sources: [leaderboardSource(http)],
      github: new GitHubRepoAdapter({ http, token: null }),
    });

    const findSkills = report.items.find((item) => item.title === "find-skills");
    expect(findSkills).toBeDefined();
    expect(findSkills?.metadata.installs).toBe(4228408);
    expect(findSkills?.metadata.weeklyInstalls).toEqual([
      101317, 105144, 103601, 107199, 110524, 121189, 121665, 115285,
    ]);
    expect(findSkills?.metadata.isOfficial).toBe(true);
    expect(findSkills?.metadata.sourceId).toBe("skills.sh");
    expect(findSkills?.metadata.heatScore).toBeGreaterThan(0);
  });

  it("热度分随安装量升高而升高（加权计算）", async () => {
    const { http } = createStubHttp(batchRoutes());

    const report = await collectBatch({
      sources: [leaderboardSource(http)],
      github: new GitHubRepoAdapter({ http, token: null }),
    });

    const grillMe = report.items.find((item) => item.title === "grill-me");
    const findSkills = report.items.find((item) => item.title === "find-skills");
    expect(grillMe?.metadata.heatScore).toBeGreaterThan(0);
    expect(findSkills?.metadata.heatScore).toBeGreaterThan(grillMe?.metadata.heatScore ?? 0);
  });

  it("正文与 frontmatter 来自 GitHub，不是目录", async () => {
    const { http } = createStubHttp(batchRoutes());

    const report = await collectBatch({
      sources: [leaderboardSource(http)],
      github: new GitHubRepoAdapter({ http, token: null }),
    });

    const grillMe = report.items.find((item) => item.title === "grill-me");
    expect(grillMe?.metadata.frontmatter).toMatchObject({
      name: "grill-me",
      description:
        "Stress-test a plan by grilling the user with hard questions before implementation starts.",
    });
    expect(grillMe?.metadata.license).toBe("mit");
    expect(grillMe?.metadata.skillPath).toBe("skills/grill-me/SKILL.md");
    expect(grillMe?.metadata.upstreamUrl).toBe(
      "https://raw.githubusercontent.com/mattpocock/skills/main/skills/grill-me/SKILL.md",
    );
    expect(grillMe?.content).toBe(fixture(GH_FIXTURES, "skill-batch-grill-me.md"));
  });

  it("目录里没有、但仓库里真实存在的 skill 也入库，安装量按 0 计", async () => {
    const { http } = createStubHttp(batchRoutes());

    const report = await collectBatch({
      sources: [leaderboardSource(http)],
      github: new GitHubRepoAdapter({ http, token: null }),
    });

    const extra = report.items.find((item) => item.title === "unlisted-extra");
    expect(extra).toBeDefined();
    expect(extra?.metadata.installs).toBe(0);
    expect(extra?.metadata.weeklyInstalls).toEqual([]);
    expect(extra?.metadata.heatScore).toBeGreaterThan(0);
  });

  it("同一个仓库只回源一次（目录里 4 条只打 2 次 API）", async () => {
    const { http, calls } = createStubHttp(batchRoutes());

    await collectBatch({
      sources: [leaderboardSource(http)],
      github: new GitHubRepoAdapter({ http, token: null }),
    });

    const repoCalls = calls.filter((url) => url === "https://api.github.com/repos/mattpocock/skills");
    const treeCalls = calls.filter((url) =>
      url.startsWith("https://api.github.com/repos/mattpocock/skills/git/trees/"),
    );
    expect(repoCalls).toHaveLength(1);
    expect(treeCalls).toHaveLength(1);
  });
});

describe("批量编排 —— 失败不扩散", () => {
  it("一个仓库回源失败：其它仓库照常出条目，失败被记进报告", async () => {
    const { http } = createStubHttp(batchRoutes());

    const report = await collectBatch({
      sources: [leaderboardSource(http)],
      github: new GitHubRepoAdapter({ http, token: null }),
    });

    const source = report.sources[0];
    expect(source.reposScanned).toBe(6);
    expect(source.reposFailed).toBe(4);
    expect(source.ok).toBe(false);
    expect(source.error).toMatch(/回源失败/);
    // 两个成功的仓库仍然出了条目。
    expect(report.items.length).toBeGreaterThan(0);
    expect(report.items.some((item) => item.title === "find-skills")).toBe(true);
  });

  it("目录来源失败：报告里记失败，不抛错", async () => {
    const { http } = createStubHttp([
      {
        match: (url: string) => url === HOME,
        body: () => "<!DOCTYPE html><html><body>改版了</body></html>",
      },
    ]);

    const report = await collectBatch({
      sources: [leaderboardSource(http)],
      github: new GitHubRepoAdapter({ http, token: null }),
    });

    expect(report.failures).toBe(1);
    expect(report.sources[0].ok).toBe(false);
    expect(report.sources[0].items).toEqual([]);
    expect(report.sources[0].error).toMatch(/结构与预期不符/);
  });

  it("maxRepos 限制本轮回源多少个仓库，剩下的留到下次", async () => {
    const { http } = createStubHttp(batchRoutes());

    const report = await collectBatch({
      sources: [leaderboardSource(http)],
      github: new GitHubRepoAdapter({ http, token: null }),
      maxRepos: 1,
    });

    const source = report.sources[0];
    expect(source.reposScanned).toBe(1);
    expect(source.error).toMatch(/留到下次/);
  });
});
