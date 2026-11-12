/**
 * 依赖关系与检索（票 #17）—— 跑在**真实 Postgres** 上。
 *
 * 验收标准：「依赖关系可通过检索查找」，票里给的例子是
 * 「**依赖了 PDF 处理能力的资产**」——
 * 关键词落在**被依赖方**身上，命中判定却要落到**依赖方**身上。
 *
 * 所以这里验两件事：
 *   1. **按依赖目标反查**（`filters.dependsOn`）：精确地说「谁依赖了它」；
 *   2. **关键词命中依赖目标的文本**：搜「pdf」时，依赖了 PDF 工具的资产也算命中。
 *
 * 另外守住一条：没有依赖筛选时，检索结果的结构**不能变**
 * （`query.filters` 里不能平白多出一个空数组）。
 */
import { describe, expect, it } from "vitest";

import { GET as searchApi } from "@/app/api/search/route";
import { replaceAssetDependencies, writeAsset } from "@/lib/asset-writer";
import { prisma } from "@/lib/prisma";
import { getSearchService } from "@/lib/search-service";

const service = getSearchService();

/**
 * 三条资产：
 *   - pdf-batch-processor：被依赖方（「批量处理 PDF 工具」）；
 *   - pdf-report-skill：依赖方，自己一个字都没提 PDF；
 *   - standalone-skill：跟 PDF 无关的第三方条目。
 */
async function seedAssets(): Promise<void> {
  await writeAsset({
    kind: "SKILL",
    slug: "pdf-batch-processor",
    displayName: "批量处理 PDF 工具",
    license: "MIT",
    summaryZh: "批量处理 PDF 与文档转换的技能。",
    summarySource: "TEMPLATE",
    heatScore: 7,
  });

  await writeAsset({
    kind: "SKILL",
    slug: "pdf-report-skill",
    displayName: "报表生成器",
    license: "MIT",
    summaryZh: "把数据做成报表。",
    summarySource: "TEMPLATE",
    heatScore: 3,
  });

  await writeAsset({
    kind: "SKILL",
    slug: "standalone-skill",
    displayName: "独立小工具",
    license: "MIT",
    summaryZh: "跟谁都不相干。",
    summarySource: "TEMPLATE",
    heatScore: 1,
  });

  const target = await prisma.asset.findUniqueOrThrow({ where: { slug: "pdf-batch-processor" } });
  const dependent = await prisma.asset.findUniqueOrThrow({ where: { slug: "pdf-report-skill" } });

  await replaceAssetDependencies(dependent.id, [
    { toId: target.id, kind: "SKILL", constraint: ">=1.2.0" },
  ]);
}

describe("检索 —— 按依赖目标反查", () => {
  it("filters.dependsOn：只返回依赖了该资产的条目", async () => {
    await seedAssets();

    const result = await service.search({
      q: "",
      filters: { dependsOn: ["pdf-batch-processor"] },
    });

    expect(result.total).toBe(1);
    expect(result.items.map((item) => item.slug)).toEqual(["pdf-report-skill"]);
  });

  it("没有依赖关系的条目不会被带进来", async () => {
    await seedAssets();

    const result = await service.search({
      q: "",
      filters: { dependsOn: ["standalone-skill"] },
    });

    expect(result.total).toBe(0);
  });

  it("依赖筛选与关键词可以叠加", async () => {
    await seedAssets();

    const result = await service.search({
      q: "报表",
      filters: { dependsOn: ["pdf-batch-processor"] },
    });

    expect(result.total).toBe(1);
    expect(result.items[0]?.slug).toBe("pdf-report-skill");
  });

  it("slug 的大小写与空格被归一化", async () => {
    await seedAssets();

    const result = await service.search({
      q: "",
      filters: { dependsOn: ["  PDF-Batch-Processor  "] },
    });

    expect(result.total).toBe(1);
  });
});

describe("检索 —— 关键词命中依赖目标的文本", () => {
  it("搜「PDF」时，依赖了 PDF 工具的资产也算命中（自身文本没提 PDF）", async () => {
    await seedAssets();

    const result = await service.search({ q: "pdf" });

    expect(result.items.map((item) => item.slug)).toContain("pdf-report-skill");
    // 无关条目不该被带进来。
    expect(result.items.map((item) => item.slug)).not.toContain("standalone-skill");
  });

  it("依赖命中也有相关度得分（不是靠硬塞进结果里）", async () => {
    await seedAssets();

    const result = await service.search({ q: "pdf", sort: "relevance" });
    const dependent = result.items.find((item) => item.slug === "pdf-report-skill");

    expect(dependent).toBeDefined();
    expect(dependent?.score).toBeGreaterThan(0);
  });

  it("不相关的查询不会因为依赖关系被误召回", async () => {
    await seedAssets();

    const result = await service.search({ q: "kubernetes helm" });

    expect(result.total).toBe(0);
  });
});

describe("检索 —— HTTP 边界与参数翻译", () => {
  it("/api/search?dependsOn=… 生效", async () => {
    await seedAssets();

    const response = await searchApi(
      new Request("http://localhost/api/search?dependsOn=pdf-batch-processor"),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.total).toBe(1);
    expect(body.items[0].slug).toBe("pdf-report-skill");
    expect(body.query.filters.dependsOn).toEqual(["pdf-batch-processor"]);
  });

  it("没有依赖筛选时，query.filters 的结构不变（不多出空数组）", async () => {
    await seedAssets();

    const response = await searchApi(new Request("http://localhost/api/search?q=pdf"));
    const body = await response.json();

    // ⚠️ 归一化后的结构是公开契约：既有调用方按 {kind, license, official} 读它。
    expect(Object.keys(body.query.filters).sort()).toEqual(["kind", "license", "official"]);
  });
});
