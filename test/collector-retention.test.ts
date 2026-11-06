/**
 * HTTP 边界（spec 的 Seam 2）：采集运维相关的能力对着**真实测试 Postgres** 跑。
 *
 * 覆盖三件事：
 *   1. 三档保留策略：热 → 归档 → 删除；
 *   2. 采集失败告警：连续失败到阈值才告警，且告警落库；
 *   3. 采集健康状态端点：把「谁挂了、挂了几次」暴露出来。
 */
import { describe, expect, it } from "vitest";

import { GET as listAssetsBySlug } from "@/app/api/assets/route";
import { GET } from "@/app/api/collector/health/route";
import { getCollectionHealth, recordAlert } from "@/collector/alerts";
import { runCollectionTask } from "@/collector/collection-run";
import { runRetention } from "@/collector/retention";
import { prisma } from "@/lib/prisma";
import { writeAsset } from "@/lib/asset-writer";
import { getAssetBySlug, listAssets } from "@/lib/asset-query";

const DAY_MS = 24 * 60 * 60 * 1000;

type SeedOptions = {
  slug: string;
  heatScore: number;
  daysAgo: number;
  sourceId?: string | null;
};

async function seedAsset(options: SeedOptions): Promise<void> {
  const syncedAt = new Date(Date.now() - options.daysAgo * DAY_MS);
  await writeAsset({
    kind: "SKILL",
    slug: options.slug,
    displayName: options.slug,
    license: "mit",
    contentBody: "# body",
    summaryZh: "摘要",
    summarySource: "TEMPLATE",
    repoOwner: "acme",
    repoName: "skills",
    repoUrl: "https://github.com/acme/skills",
    upstreamUrl: "https://raw.githubusercontent.com/acme/skills/main/SKILL.md",
    sourceId: options.sourceId === undefined ? "skills.sh" : options.sourceId,
    lastSyncedAt: syncedAt,
    heatScore: options.heatScore,
  });
}

describe("三档保留策略", () => {
  it("窗口期内的条目保持可见（不归档也不删除）", async () => {
    await seedAsset({ slug: "hot-item", heatScore: 0.1, daysAgo: 1 });

    const report = await runRetention();

    expect(report.deleted).toBe(0);
    expect(report.archived).toBe(0);
    const asset = await prisma.asset.findUnique({ where: { slug: "hot-item" } });
    expect(asset?.archivedAt).toBeNull();
  });

  it("超期但高热度：保留于库、前端不可见", async () => {
    await seedAsset({ slug: "stale-hot", heatScore: 9, daysAgo: 90 });

    const report = await runRetention();

    expect(report.archived).toBe(1);
    expect(report.deleted).toBe(0);
    const asset = await prisma.asset.findUnique({ where: { slug: "stale-hot" } });
    expect(asset).not.toBeNull();
    expect(asset?.archivedAt).not.toBeNull();
  });

  it("已归档的条目在所有前端取数路径上都不可见（列表 / 详情 / 批量 slug）", async () => {
    await seedAsset({ slug: "archived-hidden", heatScore: 9, daysAgo: 90 });
    await seedAsset({ slug: "still-hot", heatScore: 0.1, daysAgo: 1 });

    await runRetention();

    // 列表路径。
    const listed = await listAssets({ limit: 100 });
    expect(listed.map((asset) => asset.slug)).toContain("still-hot");
    expect(listed.map((asset) => asset.slug)).not.toContain("archived-hidden");

    // 详情路径。
    expect(await getAssetBySlug("archived-hidden")).toBeNull();
    expect(await getAssetBySlug("still-hot")).not.toBeNull();

    // 批量 slug 路径（游客态「我的收藏」走这条）。
    const response = await listAssetsBySlug(
      new Request("http://localhost/api/assets?slugs=archived-hidden,still-hot"),
    );
    const body = (await response.json()) as { items: { slug: string }[] };
    expect(body.items.map((item) => item.slug)).toEqual(["still-hot"]);
  });

  it("超期且低热度：物理删除", async () => {
    await seedAsset({ slug: "stale-cold", heatScore: 0.2, daysAgo: 90 });

    const report = await runRetention();

    expect(report.deleted).toBe(1);
    expect(report.archived).toBe(0);
    const asset = await prisma.asset.findUnique({ where: { slug: "stale-cold" } });
    expect(asset).toBeNull();
  });

  it("用户自己发布的资产不参与保留策略", async () => {
    await seedAsset({ slug: "user-published", heatScore: 0.1, daysAgo: 90, sourceId: null });

    const report = await runRetention();

    expect(report.deleted).toBe(0);
    expect(report.archived).toBe(0);
    const asset = await prisma.asset.findUnique({ where: { slug: "user-published" } });
    expect(asset).not.toBeNull();
  });

  it("被归档的条目重新采集后恢复可见", async () => {
    await seedAsset({ slug: "recovered", heatScore: 9, daysAgo: 90 });
    await runRetention();
    expect((await prisma.asset.findUnique({ where: { slug: "recovered" } }))?.archivedAt).not.toBeNull();

    await writeAsset({
      kind: "SKILL",
      slug: "recovered",
      displayName: "recovered",
      license: "mit",
      sourceId: "skills.sh",
      lastSyncedAt: new Date(),
    });

    expect((await prisma.asset.findUnique({ where: { slug: "recovered" } }))?.archivedAt).toBeNull();
  });
});

describe("采集失败告警", () => {
  it("单源连续失败达到阈值时产生告警并落库", async () => {
    for (let i = 0; i < 3; i += 1) {
      await runCollectionTask({
        source: "skills.sh:leaderboard",
        sourceType: "skills-sh",
        task: async () => {
          throw new Error("解析器失效：榜单字段改名了");
        },
      });
    }

    const alerts = await prisma.collectionAlert.findMany();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].source).toBe("skills.sh:leaderboard");
    expect(alerts[0].severity).toBe("ERROR");
    expect(alerts[0].occurrences).toBe(3);
    expect(alerts[0].detail).toMatch(/解析器失效/);
    expect(alerts[0].acknowledgedAt).toBeNull();
  });

  it("失败次数没到阈值时不告警", async () => {
    for (let i = 0; i < 2; i += 1) {
      await runCollectionTask({
        source: "skills.sh:leaderboard",
        sourceType: "skills-sh",
        task: async () => {
          throw new Error("网络抖动");
        },
      });
    }

    expect(await prisma.collectionAlert.count()).toBe(0);
    expect((await prisma.collectionRun.count())).toBe(2);
  });

  it("成功一次会打断连续失败的计数", async () => {
    for (let i = 0; i < 2; i += 1) {
      await runCollectionTask({
        source: "skills.sh:leaderboard",
        sourceType: "skills-sh",
        task: async () => {
          throw new Error("网络抖动");
        },
      });
    }
    await runCollectionTask({
      source: "skills.sh:leaderboard",
      sourceType: "skills-sh",
      task: async () => ({ fetched: 10, written: 10, failed: 0, failures: 0 }),
    });
    for (let i = 0; i < 2; i += 1) {
      await runCollectionTask({
        source: "skills.sh:leaderboard",
        sourceType: "skills-sh",
        task: async () => {
          throw new Error("又挂了");
        },
      });
    }

    expect(await prisma.collectionAlert.count()).toBe(0);
  });

  it("部分失败记 WARNING 告警，不会每天堆一条", async () => {
    for (let i = 0; i < 3; i += 1) {
      await runCollectionTask({
        source: "skills.sh:sitemap",
        sourceType: "skills-sh",
        task: async () => ({
          fetched: 100,
          written: 98,
          failed: 0,
          failures: 2,
          error: "2 个仓库 404",
        }),
      });
    }

    const alerts = await prisma.collectionAlert.findMany();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("WARNING");
  });
});

describe("采集健康状态", () => {
  it("没有运行记录时是 ok", async () => {
    const health = await getCollectionHealth();

    expect(health.status).toBe("ok");
    expect(health.sources).toEqual([]);
    expect(health.openAlerts).toBe(0);
  });

  it("连续失败到阈值时状态变成 error", async () => {
    for (let i = 0; i < 3; i += 1) {
      await runCollectionTask({
        source: "skills.sh:leaderboard",
        sourceType: "skills-sh",
        task: async () => {
          throw new Error("挂了");
        },
      });
    }

    const health = await getCollectionHealth();
    expect(health.status).toBe("error");
    expect(health.sources[0].source).toBe("skills.sh:leaderboard");
    expect(health.sources[0].consecutiveFailures).toBe(3);
    expect(health.openAlerts).toBe(1);
  });

  it("刚失败一次时状态是 degraded", async () => {
    await runCollectionTask({
      source: "skills.sh:leaderboard",
      sourceType: "skills-sh",
      task: async () => {
        throw new Error("挂了");
      },
    });

    const health = await getCollectionHealth();
    expect(health.status).toBe("degraded");
    expect(health.sources[0].consecutiveFailures).toBe(1);
  });

  it("告警落库后健康状态能看到未确认告警数", async () => {
    await recordAlert({
      source: "skills.sh:leaderboard",
      severity: "ERROR",
      message: "手动告警",
    });

    const health = await getCollectionHealth();
    expect(health.openAlerts).toBe(1);
  });
});

describe("GET /api/collector/health", () => {
  it("采集正常时返回 200 与每个源的状态", async () => {
    await runCollectionTask({
      source: "skills.sh:leaderboard",
      sourceType: "skills-sh",
      task: async () => ({ fetched: 12, written: 12, failed: 0, failures: 0 }),
    });

    const response = await GET();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.status).toBe("ok");
    expect(body.sources[0].source).toBe("skills.sh:leaderboard");
    expect(body.sources[0].lastStatus).toBe("OK");
    expect(body.database.ok).toBe(true);
  });

  it("连续失败到阈值时返回 503", async () => {
    for (let i = 0; i < 3; i += 1) {
      await runCollectionTask({
        source: "skills.sh:leaderboard",
        sourceType: "skills-sh",
        task: async () => {
          throw new Error("解析器失效");
        },
      });
    }

    const response = await GET();
    expect(response.status).toBe(503);

    const body = await response.json();
    expect(body.status).toBe("error");
    expect(body.openAlerts).toBe(1);
  });
});
