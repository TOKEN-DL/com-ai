/**
 * 排序口径与排序选项（票 #24）。
 *
 * ## 覆盖什么
 *
 * spec 决策 5 定了三个热度视图（all-time / trending / hot），本票落前两个。
 * 这一层的东西错了**没人会发现**：榜单顺序变了、总数对了但排序反了，
 * 都是「看起来还是那么回事」的错误 —— 所以要有测试钉住。
 *
 * - 纯函数：排序选项按分类过滤（`sortOptionsForKinds`）、
 *   URL 里的排序口径落到页面可用口径（`resolvePageSort`）、URL 参数解析。
 * - 集成（真实 Postgres）：`sort=installs` / `sort=trending` 的**实际排序**。
 */
import { describe, expect, it } from "vitest";

import { writeAsset } from "@/lib/asset-writer";
import { prisma } from "@/lib/prisma";
import { parseSearchQuery } from "@/lib/search-params";
import { getSearchService, SEARCH_SORTS } from "@/lib/search-service";
import { resolvePageSort, SORT_LABELS, sortOptionsForKinds } from "@/lib/sort-options";

const service = getSearchService();

/**
 * 一组安装量与增速**故意互相打架**的资产 —— 这样排序口径换了，顺序一定会变，
 * 测的就是顺序而不是「恰好没变」。
 */
async function seedSortAssets(): Promise<void> {
  // 安装量最高，但增速为负（正在退烧）。
  await writeAsset({
    kind: "SKILL",
    slug: "sort-installs-high",
    displayName: "安装量最高的技能",
    license: "MIT",
    contentBody: "装得最多，但最近退烧了。",
    summaryZh: "装得最多的技能。",
    summarySource: "TEMPLATE",
    heatScore: 1,
    installs: 9000,
    trendScore: -0.5,
    stars: 10,
  });

  // 增速最快，但装得少。
  await writeAsset({
    kind: "SKILL",
    slug: "sort-trend-high",
    displayName: "增速最快的技能",
    license: "MIT",
    contentBody: "最近涨得很快。",
    summaryZh: "涨得最快的技能。",
    summarySource: "TEMPLATE",
    heatScore: 2,
    installs: 10,
    trendScore: 0.9,
    stars: 10,
  });

  // 两头都不沾。
  await writeAsset({
    kind: "SKILL",
    slug: "sort-plain",
    displayName: "普普通通的技能",
    license: "MIT",
    contentBody: "没什么特别的。",
    summaryZh: "普通技能。",
    summarySource: "TEMPLATE",
    heatScore: 3,
    installs: 100,
    trendScore: 0,
    stars: 10,
  });

  // MCP：没有安装量口径。
  await writeAsset({
    kind: "MCP",
    slug: "sort-mcp",
    displayName: "一个 MCP 服务",
    license: null,
    contentBody: "一个 MCP 服务。",
    summaryZh: "一个 MCP 服务。",
    summarySource: "TEMPLATE",
    heatScore: 4,
  });
}

describe("排序选项 —— 按分类过滤", () => {
  it("Skill 与场景卡片有安装量口径（六个选项）", () => {
    expect(sortOptionsForKinds(["SKILL"])).toContain("installs");
    expect(sortOptionsForKinds(["SKILL"])).toContain("trending");
    expect(sortOptionsForKinds(["SCENARIO"])).toContain("installs");
    expect(sortOptionsForKinds(["SCENARIO"])).toContain("trending");
  });

  it("MCP 与 Prompt 没有安装量口径（只有基础四个）", () => {
    expect(sortOptionsForKinds(["MCP"])).toEqual(["relevance", "heat", "recent", "name"]);
    expect(sortOptionsForKinds(["PROMPT"])).toEqual(["relevance", "heat", "recent", "name"]);
  });

  it("跨类型浏览给全部六个", () => {
    expect(sortOptionsForKinds()).toHaveLength(6);
    expect(sortOptionsForKinds([])).toHaveLength(6);
  });

  it("混合分类仍给六个（Skill 那部分按安装量排序有意义）", () => {
    expect(sortOptionsForKinds(["SKILL", "MCP"])).toHaveLength(6);
  });

  it("每一个排序维度都有展示名", () => {
    for (const sort of SEARCH_SORTS) {
      expect(SORT_LABELS[sort]).toBeTruthy();
    }
  });
});

describe("resolvePageSort —— 把 URL 里的排序落到页面可用口径", () => {
  const skillOptions = sortOptionsForKinds(["SKILL"]);
  const mcpOptions = sortOptionsForKinds(["MCP"]);

  it("本页支持的口径原样保留", () => {
    expect(resolvePageSort("installs", skillOptions, "")).toBe("installs");
    expect(resolvePageSort("trending", skillOptions, "")).toBe("trending");
  });

  it("本页不支持的口径退回默认（纯浏览 → 热度）", () => {
    expect(resolvePageSort("installs", mcpOptions, "")).toBe("heat");
    expect(resolvePageSort("trending", mcpOptions, "")).toBe("heat");
  });

  it("本页不支持的口径 + 有查询词 → 退回相关度", () => {
    expect(resolvePageSort("installs", mcpOptions, "pdf")).toBe("relevance");
  });

  it("没给排序 → 用默认口径", () => {
    expect(resolvePageSort(undefined, skillOptions, "")).toBe("heat");
    expect(resolvePageSort(undefined, skillOptions, "pdf")).toBe("relevance");
  });
});

describe("URL 参数 —— 排序口径", () => {
  it("安装量与近期增速能解析", () => {
    expect(parseSearchQuery(new URLSearchParams("sort=installs")).sort).toBe("installs");
    expect(parseSearchQuery(new URLSearchParams("sort=trending")).sort).toBe("trending");
  });

  it("不认识的口径不解析（交给调用方走默认）", () => {
    expect(parseSearchQuery(new URLSearchParams("sort=hot")).sort).toBeUndefined();
    expect(parseSearchQuery(new URLSearchParams("sort=whatever")).sort).toBeUndefined();
  });
});

describe("检索层 —— 安装量排序（all-time 视图）", () => {
  it("按累计安装量降序", async () => {
    await seedSortAssets();

    const result = await service.search({ q: "", sort: "installs" });

    expect(result.items[0]?.slug).toBe("sort-installs-high");
    expect(result.items.map((item) => item.installs)).toEqual([9000, 100, 10, 0]);
  });

  it("安装量口径与热度口径的顺序确实不同（测的是排序，不是碰巧没变）", async () => {
    await seedSortAssets();

    const byInstalls = await service.search({ q: "", sort: "installs" });
    const byHeat = await service.search({ q: "", sort: "heat" });

    expect(byHeat.items[0]?.slug).toBe("sort-mcp");
    expect(byInstalls.items.map((item) => item.slug)).not.toEqual(
      byHeat.items.map((item) => item.slug),
    );
  });
});

describe("检索层 —— 近期增速排序（trending 视图）", () => {
  it("按近期增速降序，增速最高的排第一", async () => {
    await seedSortAssets();

    const result = await service.search({ q: "", sort: "trending" });

    expect(result.items[0]?.slug).toBe("sort-trend-high");
    // 增速为负的排最后。
    expect(result.items[result.items.length - 1]?.slug).toBe("sort-installs-high");
  });

  it("结果条目带上增速、收藏数与点赞数", async () => {
    await seedSortAssets();
    await prisma.asset.update({
      where: { slug: "sort-trend-high" },
      data: { favoriteCount: 7, likeCount: 11 },
    });

    const result = await service.search({ q: "", sort: "trending" });
    const hit = result.items[0];

    expect(hit?.trendScore).toBe(0.9);
    expect(hit?.favoriteCount).toBe(7);
    expect(hit?.likeCount).toBe(11);
  });
});
