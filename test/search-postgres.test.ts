/**
 * 检索层在**真实 Postgres** 上的行为（spec：全文检索 + pg_trgm，不用内存替身）。
 *
 * 这里固定住当前 Postgres 的真实行为，作为 #5「关键词搜索 Skill」的地基：
 *   - 全文检索用 'simple' 配置：能按拉丁词（docker / compose）命中；
 *     'simple' 不切分中文，中文串会被当成**一个** token。
 *   - pg_trgm 能对中文做相似度匹配，但查询串至少要 3 个字符
 *     （2 个中文字符的 similarity 为 0，匹配不上）。
 */
import { describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { ASSET_FULLTEXT_EXPRESSION } from "@/lib/search-expression";

const FULLTEXT_PREDICATE = ASSET_FULLTEXT_EXPRESSION;

async function seedAssets(): Promise<void> {
  await prisma.asset.create({
    data: {
      kind: "SKILL",
      slug: "docker-compose",
      displayName: "Docker Compose 部署指南",
      summaryZh: "用 Compose 编排整套服务",
    },
  });

  await prisma.asset.create({
    data: {
      kind: "SKILL",
      slug: "redis-cache",
      displayName: "Redis 缓存配置",
      summaryZh: "缓存策略与过期时间",
    },
  });
}

describe("Postgres 全文检索", () => {
  it("能按标题里的拉丁词命中，并排除无关条目", async () => {
    await seedAssets();

    const hits = await prisma.$queryRaw<{ slug: string }[]>`
      SELECT "slug" FROM "Asset"
      WHERE ${prisma.$queryRawUnsafe(FULLTEXT_PREDICATE)} @@ plainto_tsquery('simple', 'compose')
      ORDER BY "slug"
    `;

    expect(hits.map((row) => row.slug)).toEqual(["docker-compose"]);
  });

  it("中文被 'simple' 当成单个 token，不会被拆词命中", async () => {
    await seedAssets();

    const hits = await prisma.$queryRaw<{ slug: string }[]>`
      SELECT "slug" FROM "Asset"
      WHERE ${prisma.$queryRawUnsafe(FULLTEXT_PREDICATE)} @@ plainto_tsquery('simple', '部署')
      ORDER BY "slug"
    `;

    // '部署指南' 是一个 token，单独的 '部署' 匹配不上。
    expect(hits).toEqual([]);
  });
});

describe("pg_trgm 相似度", () => {
  it("中文查询串（≥3 字）能匹配到包含该片段的资产", async () => {
    await prisma.asset.create({
      data: {
        kind: "SKILL",
        slug: "zh-summary",
        displayName: "中文简介生成技能",
        summaryZh: "为资产生成中文简介",
      },
    });

    await prisma.asset.create({
      data: {
        kind: "MCP",
        slug: "unrelated",
        displayName: "无关条目",
        summaryZh: "别的内容",
      },
    });

    const hits = await prisma.$queryRaw<{ slug: string; score: number }[]>`
      SELECT "slug", similarity("displayName", ${"中文简介生成"})::float8 AS score
      FROM "Asset"
      WHERE similarity("displayName", ${"中文简介生成"}) > 0.3
      ORDER BY score DESC, "slug"
    `;

    expect(hits.map((row) => row.slug)).toEqual(["zh-summary"]);
    expect(hits[0]?.score).toBeGreaterThan(0.3);
  });

  it("查询串只有 2 个中文字符时相似度为 0（pg_trgm 需要至少 3 个字符）", async () => {
    await prisma.asset.create({
      data: {
        kind: "SKILL",
        slug: "zh-summary-short",
        displayName: "中文简介生成技能",
      },
    });

    const [row] = await prisma.$queryRaw<{ score: number }[]>`
      SELECT similarity("displayName", ${"简介"})::float8 AS score
      FROM "Asset"
      WHERE "slug" = 'zh-summary-short'
    `;

    expect(row.score).toBe(0);
  });

  it("无关内容不会产生假匹配", async () => {
    await prisma.asset.create({
      data: {
        kind: "MCP",
        slug: "unrelated-only",
        displayName: "Redis 缓存配置",
      },
    });

    const hits = await prisma.$queryRaw<{ slug: string }[]>`
      SELECT "slug" FROM "Asset"
      WHERE similarity("displayName", ${"docker"}) > 0.3
    `;

    expect(hits).toEqual([]);
  });
});
