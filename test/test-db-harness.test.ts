/**
 * 测试 harness 自检：确认测试确实跑在**真实 Postgres** 的独立数据库上，
 * 而不是内存替身，也不是开发库。
 */
import { describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";

describe("测试数据库 harness", () => {
  it("跑在真实 Postgres 上，而不是内存替身", async () => {
    const [row] = await prisma.$queryRaw<{ version: string; database: string }[]>`
      SELECT version() AS version, current_database() AS database
    `;

    expect(row.version).toContain("PostgreSQL");
    // 每次运行现建一个 test_<随机> 库，不会碰到开发库。
    expect(row.database).toMatch(/^test_[0-9a-f]{12}$/);
    expect(row.database).not.toBe("comai");
  });

  it("每次运行用的数据库名是唯一的", () => {
    expect(process.env.TEST_DATABASE_NAME).toMatch(/^test_[0-9a-f]{12}$/);
    expect(process.env.TEST_DATABASE_URL).toContain(process.env.TEST_DATABASE_NAME);
  });

  it("迁移已应用：Asset 表与 contentTier 枚举位都在", async () => {
    const tables = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = current_schema()
    `;
    expect(tables.map((row) => row.tablename)).toContain("Asset");

    const [enumRow] = await prisma.$queryRaw<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE t.typname = 'ContentTier' AND n.nspname = current_schema()
      ) AS exists
    `;
    expect(enumRow.exists).toBe(true);
  });

  it("pg_trgm 扩展可用（检索层依赖它，必须是真实 PG 特性）", async () => {
    const [row] = await prisma.$queryRaw<{ installed: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS installed
    `;
    expect(row.installed).toBe(true);
  });
});

describe("测试之间的数据隔离", () => {
  it("测试 A：写入一条资产", async () => {
    await prisma.asset.create({
      data: {
        kind: "SKILL",
        slug: "isolation-a",
        displayName: "隔离测试 A",
      },
    });

    expect(await prisma.asset.count()).toBe(1);
  });

  it("测试 B：看不到测试 A 写入的数据", async () => {
    // 清库发生在每个测试之前，所以这里必须是空的。
    expect(await prisma.asset.count()).toBe(0);

    const leaked = await prisma.asset.findUnique({ where: { slug: "isolation-a" } });
    expect(leaked).toBeNull();
  });
});
