/**
 * 采集的**单飞保护**（Postgres advisory lock）。
 *
 * 为什么需要：采集 cron 的唯一归属是定时任务容器，但**容器会被扩到多副本**
 * （滚动发布、跨可用区部署）。多个副本同时触发同一个源的采集 = 重复回源
 * + 重复入库 —— 这是**正确性 bug**，不只是浪费。数据库层面加一把锁，保证
 * **同一时刻只有一个实例真的在采集这个源**，其余实例本轮直接跳过。
 *
 * 为什么用 advisory lock，而不是表锁 / 唯一约束：
 *   - 表锁会把整张表挡住，而采集本身要写 `CollectionRun` / `CollectionAlert`；
 *   - 唯一约束只能在**写完之后**才发现重复，来不及阻止重复回源；
 *   - advisory lock 是**会话级**的：进程崩了、连接断了，锁**自动释放**，
 *     不会像需要显式清理的残留锁那样把后续采集全堵死。
 *
 * ⚠️ `pg_try_advisory_lock` 是**会话级**锁：必须在**同一条连接**上
 *    「拿锁 → 干活 → 解锁」。中途换连接就等于换会话，锁会失效。
 *    所以这里全程复用同一个 `PoolClient`。
 */
import { Pool, type PoolClient } from "pg";

/**
 * advisory lock 的命名空间（固定值，与采集源无关）。
 *
 * 第二个参数才是源的哈希 —— 命名空间一样、哈希不同 ⇒ **不同源互不阻塞**。
 * 选一个固定常量是为了不和别的子系统抢锁（别的锁用别的命名空间）。
 */
export const COLLECTION_LOCK_NAMESPACE = 0x434f4d41; // "COMA"

/**
 * 采集源标识 → 32 位稳定哈希（FNV-1a）。
 *
 * 必须**跨进程稳定**：不能用 `String.prototype.hashCode` 之类随运行时
 * 变化的东西，否则两个容器算出来的 key 不一样，单飞就失效了。
 * FNV-1a 是纯函数，任何语言 / 任何 Node 版本算出来都一样。
 */
export function collectionLockKey(source: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  // 收成有符号 32 位：Postgres int4 的取值范围。
  return hash | 0;
}

/** 模块内的连接池单例：拿锁要独占一条连接，不能每次现建。 */
let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL ?? "";
    if (!connectionString) {
      throw new Error("缺少 DATABASE_URL，无法获取采集单飞锁");
    }
    pool = new Pool({ connectionString, connectionTimeoutMillis: 5_000 });
  }
  return pool;
}

/** 关掉模块内的连接池（测试与优雅退出用）。 */
export async function closeCollectionLockPool(): Promise<void> {
  const current = pool;
  pool = null;
  if (current) {
    await current.end();
  }
}

export type CollectionLockOutcome<T> = {
  /// 是否真的拿到了锁。false = 别的实例正在采集这个源，本轮跳过。
  acquired: boolean;
  /// 拿到锁时任务的返回值。
  value?: T;
};

export type CollectionLockOptions = {
  /// 采集源标识（如 "skills.sh:leaderboard"）。锁 key 带它，不同源互不阻塞。
  source: string;
  /// 连接池（默认用模块内的单例；测试可注入自己的）。
  pool?: Pool;
};

/**
 * 在 advisory lock 的保护下跑一个采集任务。
 *
 * 拿不到锁（别的实例正在采集这个源）时**不排队、不等待**，直接跳过本轮：
 * 采集是「每天一次」的节奏，等上一轮跑完再补跑没有意义，反而可能把负载
 * 叠在同一个源上。
 *
 * 锁在 `finally` 里释放：任务失败 / 抛错都不能把锁留在会话上。
 */
export async function withCollectionLock<T>(
  options: CollectionLockOptions,
  task: () => Promise<T>,
): Promise<CollectionLockOutcome<T>> {
  const target = options.pool ?? getPool();
  const key = collectionLockKey(options.source);

  // 全程复用同一条连接：advisory lock 是会话级的，换连接就等于换会话。
  const client: PoolClient = await target.connect();
  try {
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1, $2) AS locked",
      [COLLECTION_LOCK_NAMESPACE, key],
    );
    if (result.rows[0]?.locked !== true) {
      console.log(
        `[collector] ${options.source}：另一实例正在采集（没拿到单飞锁），本轮跳过`,
      );
      return { acquired: false };
    }

    try {
      const value = await task();
      return { acquired: true, value };
    } finally {
      await client.query("SELECT pg_advisory_unlock($1, $2)", [
        COLLECTION_LOCK_NAMESPACE,
        key,
      ]);
    }
  } finally {
    client.release();
  }
}
