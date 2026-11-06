/**
 * Seam 1 —— 采集边界（主 seam，票 #4 验收标准第 4 条）。
 *
 * 契约：**输入源配置 → 输出规范化条目数组**。
 * 这里用录制的 fixture（真实 GitHub API 响应 + 真实 SKILL.md 原文）驱动，
 * 一个网络请求都不打。
 *
 * 三类 fixture 覆盖：
 *   1. 正常条目   —— tree-vercel-labs-skills.json / repo-vercel-labs-skills.json / skill-find-skills.md
 *   2. 字段缺失   —— repo-anthropics-skills.json（无 license）/ tree-missing-fields.json（条目缺 size、url）/ skill-no-description.md（frontmatter 缺 description）
 *   3. 结构变更   —— tree-changed-shape.json（tree 不再是数组）/ repo-changed-shape.json（仓库元数据字段改名）
 *
 * ⚠️ 结构变更必须**显式抛错**，不能静默返回空数组 —— 否则上游改版时，
 *    采集器会安静地采到 0 条，看不出是「没数据」还是「解析炸了」。
 *
 * 端点事实来自 .com-ai-context/verified-endpoints.md（实测优先）：
 *   - 路径布局三套（skills/<name>/、skills/<category>/<name>/、.automations/**），
 *     绝不能拼路径猜，只能 trees API 一次拿全树再本地筛；
 *   - `SKILL.md` 必须严格比较最后一段（`.changeset/software-factory-skill.md` 是陷阱）；
 *   - frontmatter 的 description 可能是 YAML 块标量多行；
 *   - frontmatter 的 license 可选。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SourceStructureError } from "@/collector/errors";
import { GitHubRepoAdapter } from "@/collector/github";
import type { HttpClient } from "@/collector/http";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "github");

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), "utf8");
}

/** 打桩的 HTTP 客户端：按 URL 路由到 fixture。记录调用过的 URL。 */
function createStubHttp(
  routes: { match: (url: string) => boolean; body: (url: string) => string }[],
): {
  http: HttpClient;
  calls: string[];
} {
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

const VERCEL_REPO = "https://api.github.com/repos/vercel-labs/skills";

/**
 * vercel-labs/skills 的真实布局（实测）：
 *   skills/find-skills/SKILL.md
 *   .automations/pr-labeling/skills/pr-labeling/SKILL.md
 *   .automations/triage/skills/triage/SKILL.md
 *   .vc/automations/workflows/pr-labeling/skills/pr-labeling/SKILL.md
 *   .vc/automations/workflows/triage/skills/triage/SKILL.md
 * 后两个与前面两个 frontmatter 的 name 相同 —— 采集器必须按 name 去重。
 */
const VERCEL_RAW_FILES: Record<string, string> = {
  "skills/find-skills/SKILL.md": "skill-find-skills.md",
  ".automations/pr-labeling/skills/pr-labeling/SKILL.md": "skill-vercel-pr-labeling-automations.md",
  ".automations/triage/skills/triage/SKILL.md": "skill-vercel-triage-automations.md",
  ".vc/automations/workflows/pr-labeling/skills/pr-labeling/SKILL.md": "skill-vercel-pr-labeling-vc.md",
  ".vc/automations/workflows/triage/skills/triage/SKILL.md": "skill-vercel-triage-vc.md",
};

function vercelRoutes(overrides: { repo?: string; tree?: string } = {}) {
  return [
    {
      match: (url: string) => url === VERCEL_REPO,
      body: () => overrides.repo ?? fixture("repo-vercel-labs-skills.json"),
    },
    {
      match: (url: string) => url.startsWith(`${VERCEL_REPO}/git/trees/`),
      body: () => overrides.tree ?? fixture("tree-vercel-labs-skills.json"),
    },
    {
      match: (url: string) => url.startsWith("https://raw.githubusercontent.com/vercel-labs/skills/main/"),
      body: (url: string) => {
        const rawPath = url.replace("https://raw.githubusercontent.com/vercel-labs/skills/main/", "");
        const file = VERCEL_RAW_FILES[rawPath];
        if (!file) {
          throw new Error(`fixture 未覆盖这个 raw 路径：${rawPath}`);
        }
        return fixture(file);
      },
    },
  ];
}

/** anthropics/skills：仓库无许可证 + 树条目缺字段 + frontmatter 缺 description。 */
function missingFieldRoutes() {
  return [
    {
      match: (url: string) => url === "https://api.github.com/repos/anthropics/skills",
      body: () => fixture("repo-anthropics-skills.json"),
    },
    {
      match: (url: string) =>
        url.startsWith("https://api.github.com/repos/anthropics/skills/git/trees/"),
      body: () => fixture("tree-missing-fields.json"),
    },
    {
      match: (url: string) => url.startsWith("https://raw.githubusercontent.com/"),
      body: () => fixture("skill-no-description.md"),
    },
  ];
}

describe("GitHub 回源适配器 —— 正常条目", () => {
  it("解析出 slug、frontmatter、许可证、SKILL.md 路径与来源地址", async () => {
    const { http } = createStubHttp(vercelRoutes());
    const adapter = new GitHubRepoAdapter({ http });

    const result = await adapter.fetch({ type: "github-repo", owner: "vercel-labs", repo: "skills" });

    expect(result.sourceType).toBe("github-repo");

    const item = result.items.find((candidate) => candidate.slug === "vercel-labs-skills-find-skills");
    expect(item).toBeDefined();
    expect(item?.title).toBe("find-skills");
    expect(item?.metadata.license).toBe("mit");
    expect(item?.metadata.description).toBe(
      "Helps users discover and install agent skills when they ask questions like \"how do I do X\", \"find a skill for X\", \"is there a skill that can...\", or express interest in extending capabilities. This skill should be used when the user is looking for functionality that might exist as an installable skill.",
    );
    expect(item?.metadata.skillPath).toBe("skills/find-skills/SKILL.md");
    expect(item?.metadata.frontmatter).toMatchObject({ name: "find-skills" });
    expect(item?.metadata.repoOwner).toBe("vercel-labs");
    expect(item?.metadata.repoName).toBe("skills");
    expect(item?.metadata.repoUrl).toBe("https://github.com/vercel-labs/skills");
    expect(item?.metadata.upstreamUrl).toBe(
      "https://raw.githubusercontent.com/vercel-labs/skills/main/skills/find-skills/SKILL.md",
    );
    expect(item?.metadata.stars).toBe(38277);
  });

  it("正文与录制的 SKILL.md 逐字一致", async () => {
    const { http } = createStubHttp(vercelRoutes());
    const adapter = new GitHubRepoAdapter({ http });

    const result = await adapter.fetch({ type: "github-repo", owner: "vercel-labs", repo: "skills" });
    const item = result.items.find((candidate) => candidate.slug === "vercel-labs-skills-find-skills");

    expect(item?.content).toBe(fixture("skill-find-skills.md"));
  });

  it("一次拿全树再本地筛 SKILL.md：只请求一次 trees 接口", async () => {
    const { http, calls } = createStubHttp(vercelRoutes());
    const adapter = new GitHubRepoAdapter({ http });

    await adapter.fetch({ type: "github-repo", owner: "vercel-labs", repo: "skills" });

    expect(calls.filter((url) => url.includes("/git/trees/"))).toHaveLength(1);
  });

  it("同一个 frontmatter name 出现在两个路径时只留一条，保留路径最短的那个", async () => {
    const { http } = createStubHttp(vercelRoutes());
    const adapter = new GitHubRepoAdapter({ http });

    const result = await adapter.fetch({ type: "github-repo", owner: "vercel-labs", repo: "skills" });

    const slugs = result.items.map((item) => item.slug).sort();
    expect(slugs).toEqual([
      "vercel-labs-skills-find-skills",
      "vercel-labs-skills-pr-labeling",
      "vercel-labs-skills-triage",
    ]);

    const prLabeling = result.items.find((item) => item.slug === "vercel-labs-skills-pr-labeling");
    expect(prLabeling?.metadata.skillPath).toBe(".automations/pr-labeling/skills/pr-labeling/SKILL.md");
  });

  it("指定 skillPath 时只采那一个 SKILL.md", async () => {
    const { http } = createStubHttp(vercelRoutes());
    const adapter = new GitHubRepoAdapter({ http });

    const result = await adapter.fetch({
      type: "github-repo",
      owner: "vercel-labs",
      repo: "skills",
      skillPath: "skills/find-skills/SKILL.md",
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].slug).toBe("vercel-labs-skills-find-skills");
  });

  it("附属文件清单来自同一棵树里的同级文件", async () => {
    const { http } = createStubHttp([
      {
        match: (url: string) => url === "https://api.github.com/repos/obra/superpowers",
        body: () => fixture("repo-obra-superpowers.json"),
      },
      {
        match: (url: string) =>
          url.startsWith("https://api.github.com/repos/obra/superpowers/git/trees/"),
        body: () => fixture("tree-obra-superpowers.json"),
      },
      {
        match: (url: string) => url.startsWith("https://raw.githubusercontent.com/"),
        body: () => fixture("skill-brainstorming.md"),
      },
    ]);
    const adapter = new GitHubRepoAdapter({ http });

    const result = await adapter.fetch({ type: "github-repo", owner: "obra", repo: "superpowers" });

    const brainstorming = result.items.find(
      (item) => item.metadata.skillPath === "skills/brainstorming/SKILL.md",
    );
    expect(brainstorming).toBeDefined();
    expect(brainstorming?.metadata.extraFiles).toEqual([
      { path: "skills/brainstorming/builder-check-prompt.md", size: expect.any(Number) },
      { path: "skills/brainstorming/scripts/frame-template.html", size: expect.any(Number) },
      { path: "skills/brainstorming/scripts/helper.js", size: expect.any(Number) },
      { path: "skills/brainstorming/scripts/server.cjs", size: expect.any(Number) },
      { path: "skills/brainstorming/scripts/start-server.sh", size: expect.any(Number) },
      { path: "skills/brainstorming/scripts/stop-server.sh", size: expect.any(Number) },
      { path: "skills/brainstorming/visual-companion.md", size: expect.any(Number) },
    ]);
  });
});

describe("GitHub 回源适配器 —— SKILL.md 识别不能被通配误伤", () => {
  it("mattpocock/skills：.changeset/software-factory-skill.md 不算 SKILL.md", async () => {
    const { http, calls } = createStubHttp([
      {
        match: (url: string) => url === "https://api.github.com/repos/mattpocock/skills",
        body: () => fixture("repo-mattpocock-skills.json"),
      },
      {
        match: (url: string) =>
          url.startsWith("https://api.github.com/repos/mattpocock/skills/git/trees/"),
        body: () => fixture("tree-mattpocock-skills.json"),
      },
      {
        match: (url: string) => url.startsWith("https://raw.githubusercontent.com/"),
        body: () => fixture("skill-brainstorming.md"),
      },
    ]);
    const adapter = new GitHubRepoAdapter({ http });

    await adapter.fetch({ type: "github-repo", owner: "mattpocock", repo: "skills" });

    // 录制的那棵树里，严格「最后一段 === SKILL.md」的正好 39 个；
    // 用 endsWith 会变成 40 个（多一个 .changeset/software-factory-skill.md）。
    const rawCalls = calls.filter((url) => url.startsWith("https://raw.githubusercontent.com/"));
    expect(rawCalls).toHaveLength(39);
    expect(rawCalls.some((url) => url.includes(".changeset/software-factory-skill.md"))).toBe(false);
  });
});

describe("GitHub 回源适配器 —— 字段缺失", () => {
  it("仓库没有声明许可证：条目照常产出，许可证为 null", async () => {
    const { http } = createStubHttp(missingFieldRoutes());
    const adapter = new GitHubRepoAdapter({ http });

    const result = await adapter.fetch({ type: "github-repo", owner: "anthropics", repo: "skills" });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].metadata.license).toBeNull();
    expect(result.items[0].metadata.frontmatter).toMatchObject({ name: "find-skills" });
  });

  it("树条目缺 size：附属文件的 size 为 null，不抛错", async () => {
    const { http } = createStubHttp(missingFieldRoutes());
    const adapter = new GitHubRepoAdapter({ http });

    const result = await adapter.fetch({ type: "github-repo", owner: "anthropics", repo: "skills" });

    expect(result.items[0].metadata.extraFiles).toEqual([
      { path: "skills/pdf/reference.md", size: null },
      { path: "skills/pdf/scripts/run.sh", size: null },
    ]);
  });

  it("frontmatter 缺 description：描述字段为 null，其余字段照常", async () => {
    const { http } = createStubHttp(missingFieldRoutes());
    const adapter = new GitHubRepoAdapter({ http });

    const result = await adapter.fetch({ type: "github-repo", owner: "anthropics", repo: "skills" });

    const item = result.items[0];
    expect(item.metadata.description).toBeNull();
    expect(item.metadata.license).toBeNull();
    expect(item.content).toBe(fixture("skill-no-description.md"));
  });
});

describe("GitHub 回源适配器 —— 结构变更必须显式失败", () => {
  it("trees 接口的 tree 不再是数组：抛 SourceStructureError，不返回空条目", async () => {
    const { http } = createStubHttp(vercelRoutes({ tree: fixture("tree-changed-shape.json") }));
    const adapter = new GitHubRepoAdapter({ http });

    await expect(
      adapter.fetch({ type: "github-repo", owner: "vercel-labs", repo: "skills" }),
    ).rejects.toBeInstanceOf(SourceStructureError);
  });

  it("仓库元数据字段改名（没有 full_name / default_branch）：抛 SourceStructureError", async () => {
    const { http } = createStubHttp(vercelRoutes({ repo: fixture("repo-changed-shape.json") }));
    const adapter = new GitHubRepoAdapter({ http });

    await expect(
      adapter.fetch({ type: "github-repo", owner: "vercel-labs", repo: "skills" }),
    ).rejects.toBeInstanceOf(SourceStructureError);
  });
});

describe("GitHub 回源适配器 —— 配置校验", () => {
  it("缺 owner 或 repo 的配置不合法", async () => {
    const adapter = new GitHubRepoAdapter({ http: createStubHttp([]).http });

    expect(adapter.validateConfig({ type: "github-repo", owner: "", repo: "skills" })).toBe(false);
    expect(adapter.validateConfig({ type: "github-repo", owner: "vercel-labs", repo: "" })).toBe(false);
    expect(
      adapter.validateConfig({ type: "github-repo", owner: "vercel-labs", repo: "skills" }),
    ).toBe(true);
  });

  it("配置不合法时直接抛错，不发请求", async () => {
    const { http, calls } = createStubHttp([]);
    const adapter = new GitHubRepoAdapter({ http });

    await expect(
      adapter.fetch({ type: "github-repo", owner: "vercel-labs", repo: "" }),
    ).rejects.toThrow(/repo/i);
    expect(calls).toHaveLength(0);
  });
});
