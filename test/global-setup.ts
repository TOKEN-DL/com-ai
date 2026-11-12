/**
 * vitest globalSetup —— 测试数据库 harness。
 *
 * spec 的硬性要求：HTTP 边界测试必须跑在**真实 Postgres** 上，不用内存替身
 * （全文检索与 trigram 的行为只有在真实 PG 上才作数）。
 *
 * 每次测试运行：
 *   1. 在测试库里建一个唯一命名的数据库（test_<随机>），跑完删掉；
 *   2. 把 Prisma 迁移应用到它上面；
 *   3. 把连接串写进 DATABASE_URL / TEST_DATABASE_URL，测试 worker 进程继承。
 *
 * 唯一命名 → 并行 worktree 互不干扰；每轮新建 → 不复用上一轮的脏数据。
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 测试库的管理连接串。用它连上去建 / 删每次运行的独立数据库。
 * 默认值对应 docker-compose 的 postgres-test 服务（宿主机 5433）。
 */
const ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ??
  "postgresql://comai:comai_test_password@localhost:5433/postgres";

const PRISMA_CLI = path.join(repoRoot, "node_modules", "prisma", "build", "index.js");

function randomDatabaseName(): string {
  return `test_${randomBytes(6).toString("hex")}`;
}

/** 把管理连接串的库名换成目标库名，其余部分（主机 / 端口 / 账号）保持不变。 */
function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** 把 Prisma 迁移应用到指定数据库。 */
function applyMigrations(databaseUrl: string): void {
  execFileSync(process.execPath, [PRISMA_CLI, "migrate", "deploy"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}

export default async function setup(): Promise<() => Promise<void>> {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();

  const database = randomDatabaseName();

  /** 删库（幂等）。初始化中途失败时也要调用，避免留下孤儿测试库。 */
  const dropDatabase = async (): Promise<void> => {
    const client = new Client({ connectionString: ADMIN_URL });
    await client.connect();
    try {
      // WITH (FORCE)：即使还有连接残留也强制断开，避免 DROP 卡住。
      await client.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    } finally {
      await client.end();
    }
  };

  try {
    await admin.query(`CREATE DATABASE "${database}"`);
  } finally {
    await admin.end();
  }

  const databaseUrl = withDatabase(ADMIN_URL, database);

  try {
    applyMigrations(databaseUrl);
  } catch (error) {
    // 迁移失败：先把刚建的库删掉，不留孤儿。
    await dropDatabase();
    throw error;
  }

  // worker 进程在 globalSetup 之后才 fork，会继承这两个变量。
  process.env.DATABASE_URL = databaseUrl;
  process.env.TEST_DATABASE_URL = databaseUrl;
  process.env.TEST_DATABASE_NAME = database;

  console.log(`[test-harness] 本轮测试数据库：${database}`);

  return async function teardown(): Promise<void> {
    await dropDatabase();
    console.log(`[test-harness] 已删除测试数据库：${database}`);
  };
}
