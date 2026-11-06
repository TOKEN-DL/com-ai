/**
 * 测试库操作helper。
 *
 * 这里的清库是「测试之间数据隔离」的落地方式：每个测试开始前把当前 schema 下
 * 的业务表全部 TRUNCATE（不含 Prisma 自己的迁移表）。
 */
import { prisma } from "@/lib/prisma";

/** 清空当前 schema 下所有业务表（保留 _prisma_migrations）。 */
export async function resetDatabase(): Promise<void> {
  const tables = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
    `SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename <> '_prisma_migrations'`,
  );

  if (tables.length === 0) {
    return;
  }

  const tableList = tables.map((row) => `"${row.tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`,
  );
}
