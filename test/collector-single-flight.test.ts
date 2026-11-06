/**
 * 采集的**单飞保护**：Postgres advisory lock（真实 Postgres 验证，不用替身）。
 *
 * 为什么要有这层保护：采集 cron 的唯一归属是定时任务容器，但容器会被扩到
 * 多副本。多个副本同时采同一个源 = 重复回源 + 重复入库（正确性 bug）。
 * advisory lock 保证同一时刻只有一个实例真的在采集。
 *
 * 锁是**会话级**的：必须同一条连接「拿锁 → 干活 → 解锁」，所以这里顺带
 * 盯住两件事：
 *   - 任务失败 / 抛错时锁也会被释放（否则这个源永远采不了了）；
 *   - 锁是按**源**分的：不同源互不阻塞。
 */
import { afterAll, describe, expect, it } from "vitest";

import {
  closeCollectionLockPool,
  collectionLockKey,
  withCollectionLock,
} from "@/collector/collection-lock";

describe("采集单飞保护 —— Postgres advisory lock", () => {
  afterAll(async () => {
    await closeCollectionLockPool();
  });

  it("锁的 key 带采集源：同一个源稳定、不同源不同", () => {
    expect(collectionLockKey("skills.sh:leaderboard")).toBe(
      collectionLockKey("skills.sh:leaderboard"),
    );
    expect(collectionLockKey("skills.sh:leaderboard")).not.toBe(
      collectionLockKey("skills.sh:sitemap"),
    );
    expect(collectionLockKey("retention")).not.toBe(collectionLockKey("skills.sh:sitemap"));
  });

  it("同一采集源的并发尝试：只有一个真的执行，另一个被跳过", async () => {
    let executed = 0;
    const task = async (): Promise<string> => {
      executed += 1;
      // 撑住一会儿：让第二个尝试在第一个持锁期间来抢锁。
      await new Promise((resolve) => setTimeout(resolve, 200));
      return "collected";
    };

    const outcomes = await Promise.all([
      withCollectionLock({ source: "skills.sh:leaderboard" }, task),
      withCollectionLock({ source: "skills.sh:leaderboard" }, task),
    ]);

    expect(outcomes.filter((outcome) => outcome.acquired)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.acquired)).toHaveLength(1);
    // 真正跑起来的只有一个。
    expect(executed).toBe(1);
    expect(outcomes.find((outcome) => outcome.acquired)?.value).toBe("collected");
  });

  it("不同采集源互不阻塞（锁 key 带了源标识）", async () => {
    const outcomes = await Promise.all([
      withCollectionLock({ source: "skills.sh:leaderboard" }, async () => "leaderboard"),
      withCollectionLock({ source: "skills.sh:sitemap" }, async () => "sitemap"),
    ]);

    expect(outcomes.every((outcome) => outcome.acquired)).toBe(true);
    expect(outcomes.map((outcome) => outcome.value).sort()).toEqual([
      "leaderboard",
      "sitemap",
    ]);
  });

  it("一轮结束后锁被释放：同一个源下一轮还能拿到锁", async () => {
    const first = await withCollectionLock({ source: "retention" }, async () => 1);
    expect(first.acquired).toBe(true);
    expect(first.value).toBe(1);

    const second = await withCollectionLock({ source: "retention" }, async () => 2);
    expect(second.acquired).toBe(true);
    expect(second.value).toBe(2);
  });

  it("任务抛错时锁也会被释放（不会把这个源永久堵死）", async () => {
    await expect(
      withCollectionLock({ source: "boom" }, async () => {
        throw new Error("采集炸了");
      }),
    ).rejects.toThrow("采集炸了");

    const again = await withCollectionLock({ source: "boom" }, async () => "ok");
    expect(again.acquired).toBe(true);
    expect(again.value).toBe("ok");
  });
});
