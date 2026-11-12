/**
 * 测试库操作helper。
 *
 * 这里的清库是「测试之间数据隔离」的落地方式：每个测试开始前把当前 schema 下
 * 的业务表全部 TRUNCATE（不含 Prisma 自己的迁移表，也不含参考数据表）。
 */
import { prisma } from "@/lib/prisma";

/**
 * 不参与清库的表。
 *
 * - `_prisma_migrations`：Prisma 自己的迁移记录。
 * - `LicensePolicy`：许可证 → 内容档位的**参考数据**，由迁移脚本 seed。
 *   写入路径的触发器分流时查它，清掉了整条许可证分层规则就失效了。
 * - `LicenseOverride`：许可证覆盖表（票 #15），同样是由迁移脚本 seed 的**参考数据**。
 *   采集器按它决定写入 `Asset.license` 的值 —— 清掉的话，
 *   「override 决定档位」这条因果链在测试里就断了。
 */
const PRESERVED_TABLES: readonly string[] = [
  "_prisma_migrations",
  "LicensePolicy",
  "LicenseOverride",
];

/** 清空当前 schema 下所有业务表（保留参考数据与 _prisma_migrations）。 */
export async function resetDatabase(): Promise<void> {
  const tables = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
    `SELECT tablename FROM pg_tables WHERE schemaname = current_schema() AND tablename <> '_prisma_migrations'`,
  );

  const businessTables = tables.filter((row) => !PRESERVED_TABLES.includes(row.tablename));

  if (businessTables.length === 0) {
    return;
  }

  const tableList = businessTables.map((row) => `"${row.tablename}"`).join(", ");
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`,
  );
}
