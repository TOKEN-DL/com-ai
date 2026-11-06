/**
 * Seam 1 —— 多源编排（票 #4 验收标准第 5 条）：
 * **一个源采集失败时，其他源的结果仍能正常入库。**
 *
 * 这里的「失败」用的是最狠的一种：上游结构变更（`SourceStructureError`）。
 * 网络失败、配置不合法走同一条路径（都会被 outcome 记录，不抛到调用方）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { ingestItems } from "@/collector/ingest";
import { GitHubRepoAdapter } from "@/collector/github";
import type { HttpClient } from "@/collector/http";
import { collectFromSources } from "@/collector/pipeline";
import { prisma } from "@/lib/prisma";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "github");

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), "utf8");
}

function stubHttp(routes: { match: (url: string) => boolean; body: () => string }[]): HttpClient {
  return async (url: string) => {
    const route = routes.find((candidate) => candidate.match(url));
    if (!route) {
      throw new Error(`fixture 未覆盖这个 URL：${url}`);
    }
    return new Response(route.body(), { status: 200 });
  };
}

function vercelRoutes(tree: string) {
  return [
    {
      match: (url: string) => url === "https://api.github.com/repos/vercel-labs/skills",
      body: () => fixture("repo-vercel-labs-skills.json"),
    },
    {
      match: (url: string) =>
        url.startsWith("https://api.github.com/repos/vercel-labs/skills/git/trees/"),
      body: () => tree,
    },
    {
      match: (url: string) => url.startsWith("https://raw.githubusercontent.com/"),
      body: () => fixture("skill-find-skills.md"),
    },
  ];
}

describe("多源采集编排 —— 单源失败不阻塞其它源", () => {
  it("一个源结构变更抛错时，另一个源的结果照常入库", async () => {
    const goodAdapter = new GitHubRepoAdapter({
      http: stubHttp(vercelRoutes(fixture("tree-vercel-labs-skills.json"))),
    });
    const brokenAdapter = new GitHubRepoAdapter({
      http: stubHttp(vercelRoutes(fixture("tree-changed-shape.json"))),
    });

    const report = await collectFromSources([
      { adapter: goodAdapter, config: { type: "github-repo", owner: "vercel-labs", repo: "skills" } },
      { adapter: brokenAdapter, config: { type: "github-repo", owner: "vercel-labs", repo: "skills" } },
    ]);

    expect(report.failures).toBe(1);
    expect(report.outcomes).toHaveLength(2);
    expect(report.outcomes[0].ok).toBe(true);
    expect(report.outcomes[1].ok).toBe(false);
    expect(report.outcomes[1].error).toContain("结构与预期不符");

    const ingested = await ingestItems(report.items);

    expect(ingested.failed).toBe(0);
    expect(ingested.written).toBeGreaterThan(0);

    const asset = await prisma.asset.findUniqueOrThrow({
      where: { slug: "vercel-labs-skills-find-skills" },
    });
    expect(asset.kind).toBe("SKILL");
    expect(asset.displayName).toBe("find-skills");
    expect(asset.license).toBe("mit");
    expect(asset.repoOwner).toBe("vercel-labs");
    expect(asset.repoName).toBe("skills");
    expect(asset.repoUrl).toBe("https://github.com/vercel-labs/skills");
    expect(asset.upstreamUrl).toBe(
      "https://raw.githubusercontent.com/vercel-labs/skills/main/skills/find-skills/SKILL.md",
    );
    expect(asset.sourceId).toBe("github-repo");
  });

  it("入库的 frontmatter、附属文件与安装命令都落进扩展表", async () => {
    const adapter = new GitHubRepoAdapter({
      http: stubHttp(vercelRoutes(fixture("tree-vercel-labs-skills.json"))),
    });

    const report = await collectFromSources([
      { adapter, config: { type: "github-repo", owner: "vercel-labs", repo: "skills" } },
    ]);
    await ingestItems(report.items);

    const asset = await prisma.asset.findUniqueOrThrow({
      where: { slug: "vercel-labs-skills-find-skills" },
    });
    const detail = await prisma.skillDetail.findUniqueOrThrow({ where: { assetId: asset.id } });

    expect(detail.frontmatter).toMatchObject({ name: "find-skills" });
    expect(detail.skillPath).toBe("skills/find-skills/SKILL.md");
    expect(detail.hosts).toContain("claude-code");
    expect(detail.installCmds).toMatchObject({
      "claude-code": "npx skills add vercel-labs/skills --skill find-skills -a claude-code",
    });
    expect(detail.extraFiles).toEqual([]);
  });

  it("MIT 资产：正文按原文保存（逐字一致）", async () => {
    const adapter = new GitHubRepoAdapter({
      http: stubHttp(vercelRoutes(fixture("tree-vercel-labs-skills.json"))),
    });

    const report = await collectFromSources([
      { adapter, config: { type: "github-repo", owner: "vercel-labs", repo: "skills" } },
    ]);
    await ingestItems(report.items);

    const asset = await prisma.asset.findUniqueOrThrow({
      where: { slug: "vercel-labs-skills-find-skills" },
    });

    expect(asset.contentTier).toBe("FULL");
    expect(asset.contentBody).toBe(fixture("skill-find-skills.md"));
  });
});

describe("多源采集编排 —— 许可证分层在入库路径上生效", () => {
  it("上游没有声明许可证：正文被清空，元数据与链接保留", async () => {
    const adapter = new GitHubRepoAdapter({
      http: stubHttp([
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
      ]),
    });

    const report = await collectFromSources([
      { adapter, config: { type: "github-repo", owner: "anthropics", repo: "skills" } },
    ]);
    await ingestItems(report.items);

    const asset = await prisma.asset.findUniqueOrThrow({
      where: { slug: "anthropics-skills-find-skills" },
    });

    expect(asset.contentTier).toBe("METADATA_ONLY");
    expect(asset.contentBody).toBeNull();
    expect(asset.repoUrl).toBe("https://github.com/anthropics/skills");
    expect(asset.upstreamUrl).toBe(
      "https://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/SKILL.md",
    );

    const detail = await prisma.skillDetail.findUniqueOrThrow({ where: { assetId: asset.id } });
    expect(detail.frontmatter).toMatchObject({ name: "find-skills" });
  });
});
