/**
 * 检索层的集成测试（票 #5）—— 跑在**真实 Postgres** 上。
 *
 * spec 的硬性要求：检索测试不用内存替身，因为全文检索与 pg_trgm 的行为
 * （中文不分词、2 字相似度为 0、索引表达式逐字匹配）在真实 PG 上才作数。
 *
 * 这里只测**公共接口**（{@link getSearchService} 的 `search`），
 * 不测 SQL 片段 —— 实现换了接口不变，测试就该照样过。
 *
 * 数据一律走生产写入路径（writeAsset），这样许可证分层、档位清空这些
 * 规则在测试里也真实生效。
 */
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { writeAsset } from "@/lib/asset-writer";
import { prisma } from "@/lib/prisma";
import { ASSET_FULLTEXT_EXPRESSION } from "@/lib/search-expression";
import { getSearchService } from "@/lib/search-service";

const service = getSearchService();

/**
 * 测试用的一组资产。
 *
 * 覆盖：中文 / 英文标题、三种分类、三种许可证、FULL 与 METADATA_ONLY 两档、
 * 归档条目、热度与更新时间的差别，以及只能靠 trigram 模糊匹配命中的条目。
 */
async function seedAssets(): Promise<void> {
  await writeAsset({
    kind: "SKILL",
    slug: "pdf-batch-processor",
    displayName: "批量处理 PDF 工具",
    license: "MIT",
    contentBody: "这个技能可以批量处理 PDF 文件，提取文本、合并、拆分。",
    summaryZh: "批量处理 PDF 与文档转换的技能。",
    summarySource: "TEMPLATE",
    repoOwner: "demo",
    repoName: "pdf-tools",
    heatScore: 7,
    installs: 120,
    stars: 340,
    isOfficial: true,
  });

  await writeAsset({
    kind: "SKILL",
    slug: "table-helper",
    displayName: "表格处理助手",
    license: "MIT",
    contentBody: "表格处理与数据清洗。",
    summaryZh: "表格与数据的处理助手。",
    summarySource: "TEMPLATE",
    repoOwner: "demo",
    repoName: "table-tools",
    heatScore: 3,
    installs: 20,
    stars: 60,
  });

  await writeAsset({
    kind: "MCP",
    slug: "pdf-mcp-server",
    displayName: "PDF 文档 MCP 服务",
    license: null,
    contentBody: "通过 MCP 读取 PDF 文档。",
    summaryZh: "通过 MCP 读取 PDF 文档。",
    summarySource: "TEMPLATE",
    repoOwner: "demo",
    repoName: "pdf-mcp",
    heatScore: 5,
    installs: 40,
    stars: 90,
  });

  await writeAsset({
    kind: "SKILL",
    slug: "docker-compose-guide",
    displayName: "Docker Compose 部署指南",
    license: "Apache-2.0",
    contentBody: "用 Compose 编排整套服务。",
    summaryZh: "用 Compose 编排整套服务。",
    summarySource: "TEMPLATE",
    repoOwner: "demo",
    repoName: "compose-guide",
    heatScore: 9,
    installs: 300,
    stars: 800,
    isOfficial: true,
  });

  await writeAsset({
    kind: "PROMPT",
    slug: "video-prompt",
    displayName: "视频生成提示词",
    license: "CC0-1.0",
    contentBody: "生成视频的提示词模板。",
    summaryZh: "用于生成视频的提示词。",
    summarySource: "TEMPLATE",
    heatScore: 6,
  });

  await writeAsset({
    kind: "SKILL",
    slug: "zh-summary-skill",
    displayName: "中文简介生成技能",
    license: "MIT",
    contentBody: "为资产生成中文简介。",
    summaryZh: "为资产生成中文简介与 PDF 处理。",
    summarySource: "TEMPLATE",
    repoOwner: "demo",
    repoName: "zh-tools",
    heatScore: 4,
    installs: 30,
    stars: 70,
  });

  // 只能靠 trigram 模糊匹配命中的条目：
  // 全文检索匹配不上（'postgres' 不是 'postgresql' 这个 token），
  // 包含匹配也匹配不上（「postgres 备份」不是标题的子串）。
  await writeAsset({
    kind: "SKILL",
    slug: "postgres-backup-tool",
    displayName: "PostgreSQL 备份工具",
    license: "MIT",
    contentBody: "数据库备份工具，支持定时备份。",
    summaryZh: "数据库备份",
    summarySource: "TEMPLATE",
    repoOwner: "demo",
    repoName: "pg-tools",
    heatScore: 0,
  });

  // 只有正文里出现的词：FULL 档能搜到，METADATA_ONLY 档搜不到。
  await writeAsset({
    kind: "SKILL",
    slug: "body-only-full",
    displayName: "正文专属词条",
    license: "MIT",
    contentBody: "这段正文里有一个专属标记 zzqqxx。",
    summaryZh: "元数据里没有那个标记。",
    summarySource: "TEMPLATE",
    heatScore: 2,
  });

  await writeAsset({
    kind: "MCP",
    slug: "body-only-metadata",
    displayName: "元数据专属词条",
    license: null,
    contentBody: "这段正文里有一个专属标记 zzqqxx。",
    summaryZh: "元数据里也没有那个标记。",
    summarySource: "TEMPLATE",
    heatScore: 1,
  });

  // 归档条目：保留在库里，但前端不该看见，检索也不该命中。
  await writeAsset({
    kind: "SKILL",
    slug: "archived-pdf",
    displayName: "归档的 PDF 工具",
    license: "MIT",
    contentBody: "批量处理 PDF 的归档版本。",
    summaryZh: "批量处理 PDF 的归档版本。",
    summarySource: "TEMPLATE",
    heatScore: 99,
  });

  await prisma.asset.update({
    where: { slug: "archived-pdf" },
    data: { archivedAt: new Date("2026-01-01T00:00:00.000Z") },
  });
}

/**
 * 固定「更新时间」，让 recency 排序可断言。
 *
 * Prisma 的 `@updatedAt` 不允许直接写，只能走原生 SQL。
 */
async function setUpdatedAt(slug: string, iso: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "Asset" SET "updatedAt" = ${new Date(iso)} WHERE "slug" = ${slug}
  `;
}

/** 把全部资产的更新时间固定成给定的先后顺序。 */
async function fixUpdatedAtOrder(): Promise<void> {
  const order: [string, string][] = [
    ["table-helper", "2026-01-01T00:00:00.000Z"],
    ["postgres-backup-tool", "2026-01-03T00:00:00.000Z"],
    ["body-only-metadata", "2026-01-05T00:00:00.000Z"],
    ["body-only-full", "2026-01-10T00:00:00.000Z"],
    ["zh-summary-skill", "2026-01-15T00:00:00.000Z"],
    ["pdf-mcp-server", "2026-01-20T00:00:00.000Z"],
    ["video-prompt", "2026-01-25T00:00:00.000Z"],
    ["docker-compose-guide", "2026-02-01T00:00:00.000Z"],
    ["pdf-batch-processor", "2026-03-01T00:00:00.000Z"],
  ];
  for (const [slug, iso] of order) {
    await setUpdatedAt(slug, iso);
  }
}

/** 归一化 SQL 表达式：去类型转换、去多余空白、统一小写。 */
function normalizeSql(sql: string): string {
  return sql.toLowerCase().replace(/::(?:"[^"]+"|[a-z_]+)/g, "").replace(/\s+/g, " ").trim();
}

describe("SearchService —— 中文查询", () => {
  it("搜「批量处理 PDF」能返回相关 Skill，并按相关度排在前面", async () => {
    await seedAssets();

    const result = await service.search({ q: "批量处理 PDF" });

    expect(result.total).toBe(1);
    expect(result.items[0]?.slug).toBe("pdf-batch-processor");
    expect(result.items[0]?.score).toBeGreaterThan(0);
    expect(result.query.q).toBe("批量处理 PDF");
  });

  it("中文查询与英文查询都能命中同一个资产", async () => {
    await seedAssets();

    const chinese = await service.search({ q: "部署指南" });
    const english = await service.search({ q: "docker" });

    expect(chinese.items.map((item) => item.slug)).toContain("docker-compose-guide");
    expect(english.items.map((item) => item.slug)).toContain("docker-compose-guide");
  });

  it("不相关的查询不会误召回", async () => {
    await seedAssets();

    const result = await service.search({ q: "kubernetes helm" });

    expect(result.total).toBe(0);
    expect(result.items).toEqual([]);
  });
});

describe("SearchService —— pg_trgm 模糊匹配", () => {
  it("全文与包含匹配都够不着时，trigram 模糊匹配能命中", async () => {
    await seedAssets();

    // 「postgres 备份」既不是 tsvector 里的 token，也不是标题的子串，
    // 只有 trigram 相似度够得着。
    const result = await service.search({ q: "postgres 备份" });

    expect(result.items.map((item) => item.slug)).toEqual(["postgres-backup-tool"]);
    expect(result.items[0]?.score).toBeGreaterThan(0);
  });
});

describe("SearchService —— 中文短查询降级（硬要求）", () => {
  it("2 个中文字符的查询也能搜到结果（靠包含匹配兜底）", async () => {
    await seedAssets();

    const result = await service.search({ q: "简介" });

    expect(result.total).toBe(1);
    expect(result.items[0]?.slug).toBe("zh-summary-skill");
  });

  it("（对照）'simple' 分词匹配不上「简介」，命中靠的确实是包含匹配兜底", async () => {
    await seedAssets();

    // Postgres 的 'simple' 配置不切分中文：整串中文是一个 token，
    // 所以「简介」这个 token 压根不在 tsvector 里，全文检索匹配不上。
    const [row] = await prisma.$queryRaw<{ matched: boolean }[]>`
      SELECT ${Prisma.raw(ASSET_FULLTEXT_EXPRESSION)} @@ plainto_tsquery('simple', '简介') AS "matched"
      FROM "Asset"
      WHERE "slug" = 'zh-summary-skill'
    `;
    expect(row?.matched).toBe(false);

    // 但检索接口照样能把它搜出来 —— 走的是 ILIKE 包含匹配兜底。
    const result = await service.search({ q: "简介" });
    expect(result.items.map((item) => item.slug)).toEqual(["zh-summary-skill"]);
  });

  it("短英文查询（pdf）能搜到含 PDF 的条目，且忽略大小写", async () => {
    await seedAssets();

    const result = await service.search({ q: "pdf" });

    expect(result.total).toBe(3);
    expect(result.items.map((item) => item.slug)).toEqual(
      expect.arrayContaining(["pdf-batch-processor", "pdf-mcp-server", "zh-summary-skill"]),
    );
  });
});

describe("SearchService —— 内容档位", () => {
  it("FULL 档的正文参与检索，METADATA_ONLY 档的正文不参与", async () => {
    await seedAssets();

    const result = await service.search({ q: "zzqqxx" });

    // METADATA_ONLY 档的正文被数据库触发器清空了，站内不复制原文，
    // 所以它的正文词搜不到；FULL 档的搜得到。
    expect(result.items.map((item) => item.slug)).toEqual(["body-only-full"]);
  });
});

describe("SearchService —— 归档条目", () => {
  it("已归档的条目不出现在结果里", async () => {
    await seedAssets();

    const result = await service.search({ q: "归档" });

    expect(result.total).toBe(0);
  });
});

describe("SearchService —— 筛选", () => {
  it("按分类筛选", async () => {
    await seedAssets();

    const result = await service.search({ q: "", filters: { kind: ["MCP"] } });

    expect(result.total).toBe(2);
    expect(result.items.every((item) => item.kind === "MCP")).toBe(true);
  });

  it("按许可证筛选", async () => {
    await seedAssets();

    const result = await service.search({ q: "", filters: { license: ["apache-2.0"] } });

    expect(result.total).toBe(1);
    expect(result.items[0]?.slug).toBe("docker-compose-guide");
  });

  it("按「未声明许可证」筛选", async () => {
    await seedAssets();

    const result = await service.search({ q: "", filters: { license: [null] } });

    expect(result.total).toBe(2);
    expect(result.items.every((item) => item.license === null)).toBe(true);
  });

  it("按是否有官方版本筛选", async () => {
    await seedAssets();

    const official = await service.search({ q: "", filters: { official: true } });
    const unofficial = await service.search({ q: "", filters: { official: false } });

    expect(official.total).toBe(2);
    expect(official.items.every((item) => item.isOfficial)).toBe(true);
    expect(unofficial.total).toBe(7);
    expect(unofficial.items.every((item) => !item.isOfficial)).toBe(true);
  });

  it("筛选与关键词可以叠加", async () => {
    await seedAssets();

    const result = await service.search({
      q: "pdf",
      filters: { kind: ["SKILL"], official: true },
    });

    expect(result.total).toBe(1);
    expect(result.items[0]?.slug).toBe("pdf-batch-processor");
  });
});

describe("SearchService —— 排序", () => {
  it("按热度排序", async () => {
    await seedAssets();

    const result = await service.search({ q: "", sort: "heat" });

    expect(result.items.slice(0, 3).map((item) => item.slug)).toEqual([
      "docker-compose-guide",
      "pdf-batch-processor",
      "video-prompt",
    ]);
  });

  it("按更新时间排序", async () => {
    await seedAssets();
    await fixUpdatedAtOrder();

    const result = await service.search({ q: "", sort: "recent" });

    expect(result.items.map((item) => item.slug)).toEqual([
      "pdf-batch-processor",
      "docker-compose-guide",
      "video-prompt",
      "pdf-mcp-server",
      "zh-summary-skill",
      "body-only-full",
      "body-only-metadata",
      "postgres-backup-tool",
      "table-helper",
    ]);
  });

  it("按名称排序", async () => {
    await seedAssets();

    const result = await service.search({ q: "", sort: "name" });
    const names = result.items.map((item) => item.displayName);

    // 只断言相对顺序：不同 collation 下绝对位置会变，相对顺序不变。
    expect(names.indexOf("Docker Compose 部署指南")).toBeLessThan(
      names.indexOf("PDF 文档 MCP 服务"),
    );

    // 换排序维度，结果顺序确实变了。
    const byHeat = await service.search({ q: "", sort: "heat" });
    expect(byHeat.items.map((item) => item.displayName)).not.toEqual(names);
  });

  it("非相关度排序时 score 恒为 0", async () => {
    await seedAssets();

    const result = await service.search({ q: "pdf", sort: "heat" });

    expect(result.items.every((item) => item.score === 0)).toBe(true);
  });
});

describe("SearchService —— 分页", () => {
  it("分页不影响总数", async () => {
    await seedAssets();

    const first = await service.search({ q: "", sort: "heat", page: 1, pageSize: 2 });
    const second = await service.search({ q: "", sort: "heat", page: 2, pageSize: 2 });

    expect(first.total).toBe(9);
    expect(first.totalPages).toBe(5);
    expect(first.items).toHaveLength(2);
    expect(second.total).toBe(9);
    expect(second.page).toBe(2);
    expect(second.items).toHaveLength(2);
    expect(first.items[0]?.slug).not.toBe(second.items[0]?.slug);
  });

  it("页码越界时夹紧，不报错", async () => {
    await seedAssets();

    const result = await service.search({ q: "", page: 0, pageSize: 999 });

    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(100);
  });
});

describe("SearchService —— 分面", () => {
  it("给出各维度上的可选值与命中数量", async () => {
    await seedAssets();

    const result = await service.search({ q: "" });

    const kindFacet = new Map(result.facets.kind.map((bucket) => [bucket.value, bucket.count]));
    expect(kindFacet.get("SKILL")).toBe(6);
    expect(kindFacet.get("MCP")).toBe(2);
    expect(kindFacet.get("PROMPT")).toBe(1);

    const licenseFacet = new Map(
      result.facets.license.map((bucket) => [bucket.value, bucket.count]),
    );
    expect(licenseFacet.get("mit")).toBe(5);
    expect(licenseFacet.get("apache-2.0")).toBe(1);
    expect(licenseFacet.get("cc0-1.0")).toBe(1);
    // 未声明许可证是一个 null 桶。
    expect(licenseFacet.get(null)).toBe(2);

    const officialFacet = new Map(
      result.facets.official.map((bucket) => [bucket.value, bucket.count]),
    );
    expect(officialFacet.get("true")).toBe(2);
    expect(officialFacet.get("false")).toBe(7);
  });

  it("分面按「除该维度自身以外的全部条件」计算（钻取语义）", async () => {
    await seedAssets();

    const result = await service.search({ q: "", filters: { kind: ["SKILL"] } });

    // 分类分面被自己的筛选条件排除 → 三种分类都还在。
    expect(result.facets.kind).toHaveLength(3);

    // 许可证分面保留其它条件 → 只统计 SKILL 的许可证，看不到 Prompt 的 cc0-1.0。
    const licenseFacet = new Map(
      result.facets.license.map((bucket) => [bucket.value, bucket.count]),
    );
    expect(licenseFacet.get("mit")).toBe(5);
    expect(licenseFacet.get("cc0-1.0")).toBeUndefined();
  });
});

describe("SearchService —— 索引与表达式", () => {
  it("全文索引的定义与检索用的表达式是同一份（逐字一致）", async () => {
    const rows = await prisma.$queryRaw<{ expr: string }[]>`
      SELECT pg_get_expr("indexprs", "indrelid") AS "expr"
      FROM pg_index
      WHERE "indexrelid" = to_regclass('"Asset_fulltext_idx"')
    `;

    expect(rows).toHaveLength(1);
    expect(normalizeSql(rows[0].expr)).toContain(normalizeSql(ASSET_FULLTEXT_EXPRESSION));
  });
});
