/**
 * 热度指标同步（票 #24）。
 *
 * ## 这个模块在防什么
 *
 * 榜单上的安装量与 8 周趋势是**三个热度视图的原始输入**，但采集入库那条路
 * 要回源 GitHub（未认证 60 次/小时）而且会顺带重写简介。
 * 同步模块只动数字 —— 所以这里要盯住两件事：
 *
 *   1. 数字**真的**更新了（安装量、热度分、近期增速）；
 *   2. **只有数字**被更新 —— 简介、正文、「何时用」一个字都不能动。
 *
 * 第二条比第一条更要紧：热度刷新是高频操作，一不小心把内容冲了，
 * 那是无声的损失。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { computeHeatScore, weeklyTrend } from "@/collector/heat";
import { syncHeatMetrics } from "@/collector/heat-sync";
import type { HttpClient } from "@/collector/http";
import { SkillsShAdapter } from "@/collector/skills-sh";
import type { RawItem } from "@/collector/types";
import { writeAsset } from "@/lib/asset-writer";
import { prisma } from "@/lib/prisma";
import { deriveScenarioCards } from "@/lib/scenario-service";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "skills-sh");

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), "utf8");
}

/** 打桩的 HTTP 客户端：首页返回真实榜单 fixture。 */
function stubHttp(): HttpClient {
  return async (url) => {
    if (url === "https://www.skills.sh/") {
      return new Response(fixture("home-leaderboard.html"), { status: 200 });
    }
    throw new Error(`fixture 未覆盖这个 URL：${url}`);
  };
}

/** 造一条榜单条目。 */
function catalogItem(overrides: {
  slug: string;
  installs?: number;
  weeklyInstalls?: number[];
}): RawItem {
  return {
    slug: overrides.slug,
    title: overrides.slug,
    url: `https://www.skills.sh/demo/skills/${overrides.slug}`,
    publishedAt: null,
    content: "# demo",
    metadata: {
      kind: "SKILL",
      sourceId: "skills.sh",
      description: "demo",
      frontmatter: {},
      license: "MIT",
      repoOwner: "demo",
      repoName: "skills",
      repoUrl: "https://github.com/demo/skills",
      upstreamUrl: null,
      skillPath: "SKILL.md",
      extraFiles: [],
      stars: 0,
      installs: overrides.installs ?? 0,
      heatScore: 0,
      isOfficial: false,
      weeklyInstalls: overrides.weeklyInstalls,
    },
  };
}

describe("热度指标同步 —— 数字真的更新了", () => {
  it("把榜单上的安装量与增速写进已收录的资产", async () => {
    await writeAsset({
      kind: "SKILL",
      slug: "demo-skill",
      displayName: "演示技能",
      license: "MIT",
      contentBody: "正文。",
      summaryZh: "简介。",
      summarySource: "TEMPLATE",
      stars: 100,
      installs: 0,
      heatScore: 0,
      trendScore: 0,
    });

    const report = await syncHeatMetrics([
      catalogItem({
        slug: "demo-skill",
        installs: 5000,
        weeklyInstalls: [10, 10, 10, 10, 40, 40, 40, 40],
      }),
    ]);

    expect(report).toMatchObject({ scanned: 1, matched: 1, updated: 1, missing: 0, failed: 0 });

    const asset = await prisma.asset.findUniqueOrThrow({ where: { slug: "demo-skill" } });
    expect(asset.installs).toBe(5000);
    // 近一半周安装量翻倍 → 正增速。
    expect(asset.trendScore).toBeGreaterThan(0);
    // 热度分用站内记着的 star 数算，不该因为榜单没有 star 就抹掉。
    expect(asset.heatScore).toBeGreaterThan(0);
  });

  it("榜单里没有趋势序列时，增速是 0（不是脏数据）", async () => {
    await writeAsset({
      kind: "SKILL",
      slug: "demo-no-trend",
      displayName: "没有趋势数据的技能",
      license: "MIT",
      contentBody: "正文。",
      summaryZh: "简介。",
      summarySource: "TEMPLATE",
    });

    await syncHeatMetrics([catalogItem({ slug: "demo-no-trend", installs: 100 })]);

    const asset = await prisma.asset.findUniqueOrThrow({ where: { slug: "demo-no-trend" } });
    expect(asset.trendScore).toBe(0);
    expect(asset.installs).toBe(100);
  });

  it("数字没变就不写库（不制造无谓的 updatedAt 抖动）", async () => {
    const weeklyInstalls = [1, 1, 1, 1];
    await writeAsset({
      kind: "SKILL",
      slug: "demo-stable",
      displayName: "数字稳定的技能",
      license: "MIT",
      contentBody: "正文。",
      summaryZh: "简介。",
      summarySource: "TEMPLATE",
      stars: 10,
      installs: 1000,
      // 热度分必须跟同步时算出来的一致 —— 否则「没变」这件事本身就不成立。
      heatScore: computeHeatScore({ installs: 1000, stars: 10, weeklyInstalls }),
      trendScore: weeklyTrend(weeklyInstalls),
    });

    const report = await syncHeatMetrics([
      catalogItem({ slug: "demo-stable", installs: 1000, weeklyInstalls }),
    ]);

    expect(report.updated).toBe(0);
    expect(report.matched).toBe(1);
  });
});

describe("热度指标同步 —— 只动数字", () => {
  it("简介、正文与「何时用 / 怎么用」一个字都不改", async () => {
    await writeAsset({
      kind: "SKILL",
      slug: "demo-content",
      displayName: "有内容的技能",
      license: "MIT",
      contentBody: "原始正文。",
      summaryZh: "原始简介。",
      summarySource: "TEMPLATE",
      whenToUse: "原始的何时用。",
      howToUse: "原始的怎么用。",
      stars: 10,
    });

    await syncHeatMetrics([
      catalogItem({ slug: "demo-content", installs: 999, weeklyInstalls: [1, 2, 3, 4, 5, 6, 7, 8] }),
    ]);

    const asset = await prisma.asset.findUniqueOrThrow({ where: { slug: "demo-content" } });
    expect(asset.summaryZh).toBe("原始简介。");
    expect(asset.whenToUse).toBe("原始的何时用。");
    expect(asset.howToUse).toBe("原始的怎么用。");
    expect(asset.contentBody).toBe("原始正文。");
    // 数字确实变了。
    expect(asset.installs).toBe(999);
  });
});

describe("热度指标同步 —— 站内没收录的条目", () => {
  it("算成 missing，不凭空造资产", async () => {
    const report = await syncHeatMetrics([
      catalogItem({ slug: "demo-not-collected", installs: 100 }),
    ]);

    expect(report).toMatchObject({ scanned: 1, matched: 0, updated: 0, missing: 1 });
    expect(await prisma.asset.count({ where: { slug: "demo-not-collected" } })).toBe(0);
  });
});

describe("热度指标同步 —— 场景卡片跟着源资产走", () => {
  it("源资产数字变了，卡片也一起刷新", async () => {
    const source = await writeAsset({
      kind: "SKILL",
      slug: "demo-card-source",
      displayName: "有卡片的技能",
      license: "MIT",
      contentBody: "正文。",
      summaryZh: "简介。",
      summarySource: "TEMPLATE",
      whenToUse: "当需要批量处理 PDF 时使用。",
      stars: 20,
      detail: {
        skill: { frontmatter: { description: "当需要批量处理 PDF 时使用。" } },
      },
    });

    const outcome = await deriveScenarioCards(source.id);
    expect(outcome.derived).toBeGreaterThan(0);
    const cardSlug = outcome.cardSlugs[0];

    const report = await syncHeatMetrics([
      catalogItem({
        slug: "demo-card-source",
        installs: 777,
        weeklyInstalls: [10, 10, 10, 10, 40, 40, 40, 40],
      }),
    ]);

    expect(report.cardsUpdated).toBe(1);

    const card = await prisma.asset.findUniqueOrThrow({ where: { slug: cardSlug } });
    expect(card.installs).toBe(777);
    expect(card.trendScore).toBeGreaterThan(0);
  });
});

describe("热度指标同步 —— 走真实榜单 fixture（端到端）", () => {
  it("榜单 slug 与站内资产的 slug 对得上，数字同步得上", async () => {
    const result = await new SkillsShAdapter({ http: stubHttp() }).fetch({
      type: "skills-sh",
      catalog: "leaderboard",
    });

    // 取榜单前三条，按榜单给的 slug 建资产（与采集入库那条路同一套 slug 规则）。
    const sample = result.items.slice(0, 3);
    for (const item of sample) {
      await writeAsset({
        kind: "SKILL",
        slug: item.slug,
        displayName: item.title,
        license: "MIT",
        contentBody: "正文。",
        summaryZh: "简介。",
        summarySource: "TEMPLATE",
        stars: 50,
      });
    }

    const report = await syncHeatMetrics(result.items);

    expect(report.matched).toBe(sample.length);
    expect(report.updated).toBe(sample.length);
    expect(report.failed).toBe(0);

    const findSkills = await prisma.asset.findUniqueOrThrow({
      where: { slug: sample[0]?.slug },
    });
    expect(findSkills.installs).toBeGreaterThan(0);
    expect(findSkills.trendScore).not.toBe(0);
  });
});
