/**
 * 「何时用 / 怎么用」进全文检索（票 #28）。
 *
 * ## 站上的核心差异搜不到
 *
 * 站上最想被搜到的就是「何时用 / 怎么用」这两个字段 —— 它们不进检索，
 * 等于**最值钱的那部分内容是死的**。实测：站上 1110 条资产的「何时用」含
 * 「适用于」，而搜这个词只能命中 140 条 —— **970 条够不着**。
 *
 * 这里钉三件事：
 *   1. 只出现在「何时用」里的词能命中对应资产；
 *   2. 中文短查询（< 3 字符）也能命中「何时用」里的内容（ILIKE 兜底那一路）；
 *   3. 全文条件走的是 `Asset_fulltext_idx`，不是顺序扫描。
 */
import { describe, expect, it } from "vitest";

import { writeAsset } from "@/lib/asset-writer";
import { prisma } from "@/lib/prisma";
import { ASSET_FULLTEXT_EXPRESSION } from "@/lib/search-expression";
import { getSearchService } from "@/lib/search-service";

const service = getSearchService();

/**
 * 一个只出现在「何时用」里的词。
 *
 * 选它是因为它**既不在标题、也不在简介、更不在正文里** ——
 * 这样「搜得到」就只能是「何时用进了检索」的功劳，不是别的通道蹭到的。
 */
const USAGE_ONLY_TOKEN = "zzyhquandonly";

/**
 * 造一条「何时用」里带独有词的资产。
 *
 * @param slug 资产 slug
 * @param kind 资产类型
 */
async function seedUsageAsset(slug: string, kind: "SKILL" | "PROMPT" = "SKILL"): Promise<void> {
  await writeAsset({
    kind,
    slug,
    displayName: `带独有词的资产 ${slug}`,
    license: "MIT",
    contentBody: "正文里没有那个独有词。",
    summaryZh: "简介里也没有那个独有词。",
    summarySource: "TEMPLATE",
    whenToUse: `当你需要 ${USAGE_ONLY_TOKEN} 的时候用这个。`,
    howToUse: `装好之后直接 ${USAGE_ONLY_TOKEN} 即可。`,
    stars: 10,
  });
}

describe("「何时用」进全文检索（票 #28）", () => {
  it("搜只出现在「何时用」里的词能命中对应资产", async () => {
    await seedUsageAsset("usage-only-skill");

    const result = await service.search({ q: USAGE_ONLY_TOKEN });

    expect(result.items.map((item) => item.slug)).toContain("usage-only-skill");
  });

  it("「怎么用」里的词同样能命中", async () => {
    await seedUsageAsset("howto-only-skill");

    const result = await service.search({ q: USAGE_ONLY_TOKEN });

    expect(result.items.map((item) => item.slug)).toContain("howto-only-skill");
  });

  it("中文短查询（2 个字）也命中「何时用」—— 靠 ILIKE 兜底那一路", async () => {
    await writeAsset({
      kind: "SKILL",
      slug: "usage-short-query-skill",
      displayName: "短查询能命中的技能",
      license: "MIT",
      contentBody: "正文。",
      summaryZh: "简介。",
      summarySource: "TEMPLATE",
      whenToUse: "当你需要批量处理表格时使用这个技能。",
    });

    // 「simple」配置不切分中文：2 个字是整个 token，全文那一路匹配不上。
    const result = await service.search({ q: "表格" });

    expect(result.items.map((item) => item.slug)).toContain("usage-short-query-skill");
  });

  it("「何时用」命中的权重低于标题 —— 相关度排序不被带偏", async () => {
    await seedUsageAsset("usage-lower-weight-skill");
    await writeAsset({
      kind: "SKILL",
      slug: "title-higher-weight-skill",
      displayName: `${USAGE_ONLY_TOKEN} 在标题里`,
      license: "MIT",
      contentBody: "正文。",
      summaryZh: "简介。",
      summarySource: "TEMPLATE",
      whenToUse: "当你需要别的东西时使用。",
    });

    const result = await service.search({ q: USAGE_ONLY_TOKEN });

    // 标题命中（权重 A）排在「何时用」命中（权重 C）前面。
    expect(result.items[0]?.slug).toBe("title-higher-weight-skill");
  });
});

describe("全文条件走索引（票 #28）", () => {
  it("EXPLAIN 走的是 Asset_fulltext_idx，不是顺序扫描", async () => {
    await seedUsageAsset("usage-explain-skill");

    const plan = await prisma.$transaction(async (tx) => {
      // 测试库里只有十几条数据，规划器会选顺序扫描（对小表那是更便宜的选择）。
      // 这里把顺序扫描的代价抬上去，逼规划器用索引 ——
      // **能走到索引**说明查询表达式与索引定义是对得上的，
      // 而「对不上」时 Postgres 压根没法用这个索引（哪怕抬代价也没用）。
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
      const rows = await tx.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(
        `EXPLAIN SELECT "id" FROM "Asset"
         WHERE (${ASSET_FULLTEXT_EXPRESSION}) @@ plainto_tsquery('simple', $1)`,
        USAGE_ONLY_TOKEN,
      );
      return rows.map((row) => row["QUERY PLAN"]).join("\n");
    });

    expect(plan).toContain("Asset_fulltext_idx");
    expect(plan).not.toContain("Seq Scan");
  });
});
