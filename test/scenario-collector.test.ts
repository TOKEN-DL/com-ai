/**
 * 场景卡片在**采集边界**上的行为（票 #12）。
 *
 * Seam 3 —— 采集边界：派生走 `SourceAdapter` 契约，用 fixture 驱动，**不打真实网络**。
 *
 * 盯两件事：
 *   1. 采集入库之后，场景卡片**顺手就派生出来了**（零额外采集成本）；
 *   2. 卡片能被统一检索命中（它是 `kind = SCENARIO` 的资产行）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { GitHubRepoAdapter } from "@/collector/github";
import type { HttpClient } from "@/collector/http";
import { ingestItems } from "@/collector/ingest";
import { collectFromSources } from "@/collector/pipeline";
import { prisma } from "@/lib/prisma";
import { getSearchService } from "@/lib/search-service";

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

/** 走一遍真实的采集编排（fixture 驱动，不联网）。 */
async function collectAndIngest() {
  const adapter = new GitHubRepoAdapter({
    http: stubHttp(vercelRoutes(fixture("tree-vercel-labs-skills.json"))),
  });

  const report = await collectFromSources([
    { adapter, config: { type: "github-repo", owner: "vercel-labs", repo: "skills" } },
  ]);

  const ingested = await ingestItems(report.items);
  return ingested;
}

describe("采集入库时顺手派生场景卡片", () => {
  it("入库之后就有场景卡片了，并记着它是从哪个 Skill 派生的", async () => {
    const ingested = await collectAndIngest();

    expect(ingested.failed).toBe(0);
    expect(ingested.written).toBeGreaterThan(0);
    expect(ingested.scenarioCards).toBeGreaterThan(0);

    const source = await prisma.asset.findUniqueOrThrow({
      where: { slug: "vercel-labs-skills-find-skills" },
    });
    expect(source.kind).toBe("SKILL");

    const card = await prisma.asset.findFirstOrThrow({ where: { kind: "SCENARIO" } });
    expect(card.displayName.length).toBeGreaterThan(0);

    const detail = await prisma.scenarioDetail.findUniqueOrThrow({ where: { assetId: card.id } });
    expect(detail.sourceAssetId).toBe(source.id);
    expect(detail.sourceAssetSlug).toBe("vercel-labs-skills-find-skills");
  });

  it("卡片能被统一检索命中", async () => {
    await collectAndIngest();

    const card = await prisma.asset.findFirstOrThrow({ where: { kind: "SCENARIO" } });
    const result = await getSearchService().search({
      q: card.displayName,
      filters: { kind: ["SCENARIO"] },
    });

    expect(result.items.map((item) => item.slug)).toContain(card.slug);
  });

  it("同一个 Skill 重采一次，不会多出第二张卡片", async () => {
    await collectAndIngest();
    const first = await prisma.asset.findMany({ where: { kind: "SCENARIO" } });

    await collectAndIngest();
    const second = await prisma.asset.findMany({ where: { kind: "SCENARIO" } });

    expect(second).toHaveLength(first.length);
    expect(second.map((card) => card.slug).sort()).toEqual(first.map((card) => card.slug).sort());
  });
});
