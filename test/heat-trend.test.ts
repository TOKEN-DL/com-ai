/**
 * 热度与近期增速（票 #24）。
 *
 * ## 为什么这个文件现在才出现
 *
 * `src/collector/heat.ts` 从票 #6 起就存在，文件头写着「spec 的纯函数单元测试之一」，
 * 却**一直没有单测** —— 直到票 #24 要复用 `weeklyTrend` 算「近期增速」才暴露出来。
 * 顺手补上：这两个函数的取值**直接决定榜单顺序**，算错了没人会发现。
 *
 * 前两组是**既有行为的特征测试**（代码早就在跑，补的是覆盖）；
 * 后两组是本票**新增**的行为（近期增速落库 + 场景卡片继承）。
 */
import { describe, expect, it } from "vitest";

import { computeHeatScore, weeklyTrend } from "@/collector/heat";
import { ingestItems } from "@/collector/ingest";
import type { RawItem } from "@/collector/types";
import { prisma } from "@/lib/prisma";
import { deriveScenarioCards } from "@/lib/scenario-service";

/** 一条带 8 周趋势序列的采集条目。 */
function rawItemWithTrend(overrides: Partial<RawItem> = {}): RawItem {
  return {
    slug: "example-skills-trending-skill",
    title: "trending-skill",
    url: "https://github.com/example/skills/blob/main/skills/trending/SKILL.md",
    content: "# trending-skill\n\n最近涨得很猛的一个技能。",
    metadata: {
      kind: "SKILL",
      sourceId: "skills.sh",
      description: "Use this when you need to transcribe subtitles from a video file.",
      frontmatter: {
        name: "trending-skill",
        description: "Use this when you need to transcribe subtitles from a video file.",
      },
      license: "MIT",
      repoOwner: "example",
      repoName: "skills",
      repoUrl: "https://github.com/example/skills",
      upstreamUrl:
        "https://raw.githubusercontent.com/example/skills/main/skills/trending/SKILL.md",
      skillPath: "skills/trending/SKILL.md",
      extraFiles: [],
      stars: 100,
      installs: 5000,
      heatScore: 4,
      isOfficial: false,
      // 近一半的周安装量翻倍 → 增速为正。
      weeklyInstalls: [10, 10, 10, 10, 40, 40, 40, 40],
    },
    ...overrides,
  };
}

describe("weeklyTrend —— 近期增速", () => {
  it("样本不足 4 周 → 没有趋势可言（0）", () => {
    expect(weeklyTrend(undefined)).toBe(0);
    expect(weeklyTrend([])).toBe(0);
    expect(weeklyTrend([1, 2, 3])).toBe(0);
  });

  it("近一半的周安装量明显更高 → 正增速", () => {
    const trend = weeklyTrend([10, 10, 10, 10, 40, 40, 40, 40]);
    expect(trend).toBeGreaterThan(0);
    expect(trend).toBeLessThanOrEqual(1);
  });

  it("近一半腰斩 → 负增速", () => {
    const trend = weeklyTrend([40, 40, 40, 40, 10, 10, 10, 10]);
    expect(trend).toBeLessThan(0);
    expect(trend).toBeGreaterThanOrEqual(-1);
  });

  it("翻倍 → 夹在 1（不会溢出）", () => {
    expect(weeklyTrend([10, 10, 10, 10, 20, 20, 20, 20])).toBe(1);
  });

  it("没有历史基数但最近有量 → 视为增长", () => {
    expect(weeklyTrend([0, 0, 0, 0, 5, 5, 5, 5])).toBe(1);
  });

  it("完全没有量 → 没有趋势", () => {
    expect(weeklyTrend([0, 0, 0, 0, 0, 0, 0, 0])).toBe(0);
  });
});

describe("computeHeatScore —— 热度分", () => {
  it("安装量越大，热度越高", () => {
    const low = computeHeatScore({ installs: 100, stars: 10 });
    const high = computeHeatScore({ installs: 1_000_000, stars: 10 });
    expect(high).toBeGreaterThan(low);
  });

  it("star 数越大，热度越高", () => {
    const low = computeHeatScore({ installs: 1000, stars: 1 });
    const high = computeHeatScore({ installs: 1000, stars: 10000 });
    expect(high).toBeGreaterThan(low);
  });

  it("同样的安装量与 star，趋势为正时热度更高", () => {
    const flat = computeHeatScore({ installs: 1000, stars: 100 });
    const rising = computeHeatScore({
      installs: 1000,
      stars: 100,
      weeklyInstalls: [10, 10, 10, 10, 40, 40, 40, 40],
    });
    expect(rising).toBeGreaterThan(flat);
  });

  it("没有趋势数据时不做趋势修正", () => {
    const withEmpty = computeHeatScore({ installs: 1000, stars: 100, weeklyInstalls: [] });
    const without = computeHeatScore({ installs: 1000, stars: 100 });
    expect(withEmpty).toBe(without);
  });

  it("负数与非法输入按 0 处理", () => {
    expect(computeHeatScore({ installs: -5, stars: -5 })).toBe(0);
    expect(computeHeatScore({ installs: Number.NaN, stars: Number.NaN })).toBe(0);
  });
});

describe("近期增速落库", () => {
  it("采集入库时把近期增速写进库里", async () => {
    await ingestItems([rawItemWithTrend()]);

    const asset = await prisma.asset.findUniqueOrThrow({
      where: { slug: "example-skills-trending-skill" },
    });

    // 近一半周安装量翻倍 → 增速为正。
    expect(asset.trendScore).toBeGreaterThan(0);
  });

  it("没有趋势数据的条目，增速是 0", async () => {
    const item = rawItemWithTrend({ slug: "example-skills-no-trend" });
    await ingestItems([
      {
        ...item,
        metadata: { ...item.metadata, weeklyInstalls: undefined },
      },
    ]);

    const asset = await prisma.asset.findUniqueOrThrow({
      where: { slug: "example-skills-no-trend" },
    });
    expect(asset.trendScore).toBe(0);
  });

  it("场景卡片继承源资产的近期增速（卡片是源 Skill 的派生产物）", async () => {
    await ingestItems([rawItemWithTrend()]);

    const source = await prisma.asset.findUniqueOrThrow({
      where: { slug: "example-skills-trending-skill" },
    });
    expect(source.trendScore).toBeGreaterThan(0);

    const outcome = await deriveScenarioCards(source.id);
    expect(outcome.derived).toBeGreaterThan(0);

    const card = await prisma.asset.findUniqueOrThrow({
      where: { slug: outcome.cardSlugs[0] },
    });
    expect(card.trendScore).toBe(source.trendScore);
  });
});
