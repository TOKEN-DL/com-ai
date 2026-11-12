/**
 * 迁移的可重复执行（票 #3 验收标准）。
 *
 * 验的是**真实 Postgres** 上的行为，不是拿内存替身糊弄：
 *   1. 在一个全新的空库上执行迁移 → 必须成功；
 *   2. 在同一个库上再执行一次 → 必须还是成功（不重复应用、不报错）；
 *   3. 迁移完成后，#3 约定的全部业务表都在，且许可证分层的触发器确实挂上了。
 *
 * 这个测试自己建库、自己删库（库名带随机后缀），不碰 harness 用的那个库。
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ??
  "postgresql://comai:comai_test_password@localhost:5433/postgres";

const PRISMA_CLI = path.join(repoRoot, "node_modules", "prisma", "build", "index.js");

/**
 * 业务表：一张都不能少。
 *
 * #3 约定的表打底，后续每一票新增的表也都要写进来 ——
 * 否则「迁移目录被合并掉了」这类问题不会被这条断言拦住
 * （迁移条数是按磁盘动态数的，目录少一个照样自洽）。
 */
const EXPECTED_TABLES = [
  "Asset",
  "LicensePolicy",
  "SkillDetail",
  "McpDetail",
  "PromptDetail",
  "AssetVersion",
  "AssetDependency",
  "User",
  "Session",
  "Favorite",
  "Like",
  "Comment",
  "Report",
  "UserPublishedAsset",
  "UserInstall",
  // #6 的采集运维：运行记录与告警记录。
  "CollectionRun",
  "CollectionAlert",
  // #9 的邮箱验证登录：一次性登录令牌（魔法链接 / GitHub OAuth 的 state）。
  "LoginToken",
  // #15 的 Prompt 库：许可证覆盖表（仓库级 + 文件级）。
  "LicenseOverride",
];

/**
 * 仓库里有多少个迁移目录。
 *
 * 断言用「磁盘上的迁移数」而不是写死数字：新增迁移时这条断言不用跟着改，
 * 但「迁移没有被重复应用」这件事照样被盯着。
 */
const MIGRATION_COUNT = readdirSync(path.join(repoRoot, "prisma", "migrations"), {
  withFileTypes: true,
}).filter((entry) => entry.isDirectory()).length;

function randomDatabaseName(): string {
  return `t03_mig_${randomBytes(6).toString("hex")}`;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function deployMigrations(databaseUrl: string): void {
  execFileSync(process.execPath, [PRISMA_CLI, "migrate", "deploy"], {
    cwd: repoRoot,
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}

describe("迁移可在空库上成功执行，且可重复执行", () => {
  it("空库上执行一次成功，再执行一次仍然成功", async () => {
    const database = randomDatabaseName();

    const admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${database}"`);
    await admin.end();

    try {
      const databaseUrl = withDatabase(ADMIN_URL, database);

      // 第一次：空库上执行迁移。
      expect(() => deployMigrations(databaseUrl)).not.toThrow();

      // 第二次：同一个库上重复执行 —— 必须是幂等的 no-op，不能报错。
      expect(() => deployMigrations(databaseUrl)).not.toThrow();

      const client = new Client({ connectionString: databaseUrl });
      await client.connect();

      try {
        const tables = await client.query<{ tablename: string }>(
          `SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename`,
        );
        const names = tables.rows.map((row) => row.tablename);

        for (const table of EXPECTED_TABLES) {
          expect(names).toContain(table);
        }

        // 迁移记录条数 = 磁盘上的迁移数（每个迁移只应用了一次，没有被重复应用）。
        const migrations = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM "_prisma_migrations"`,
        );
        expect(migrations.rows[0]?.count).toBe(String(MIGRATION_COUNT));

        // 许可证分层的强制执行确实挂上了（绕过服务层直接写库也拦得住）。
        const triggers = await client.query<{ tgname: string }>(
          `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname`,
        );
        const triggerNames = triggers.rows.map((row) => row.tgname);
        expect(triggerNames).toContain("Asset_content_tier_guard");
        expect(triggerNames).toContain("AssetVersion_snapshot_guard");
        expect(triggerNames).toContain("PromptDetail_body_guard");
        expect(triggerNames).toContain("SkillDetail_summary_guard");
        // 互动计数也由触发器维护（绕过服务层直接写库，计数也不漂移）。
        expect(triggerNames).toContain("Favorite_asset_count_sync");
        expect(triggerNames).toContain("Like_asset_count_sync");
      } finally {
        await client.end();
      }
    } finally {
      const cleanup = new Client({ connectionString: ADMIN_URL });
      await cleanup.connect();
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    }
  }, 180_000);
});
