/**
 * Seam 2 —— HTTP/数据库边界（票 #16「版本管理与一键更新」的**自动链路**）。
 *
 * ## 盯什么
 *
 * 票 #16 的验收标准是「上游仓库有新 commit 时，变更日志被生成并入库」。
 * 「有新 commit 时」= **自动**发生，所以版本同步必须是一条**定时任务**，
 * 而不只是 `pnpm sync:versions` 这个手动入口。
 *
 * 没有这条 cron 的话，站上的 `AssetVersion` 永远是空的，
 * 收藏后的「上游有新版本」提示也就永远不会出现。
 *
 * 上游取数走**假实现**（不打真实网络）；写库走**真实测试 Postgres**
 * （版本行与变更日志必须真的落库才有意义）。
 */
import { describe, expect, it } from "vitest";

import { buildCollectionTasks, VERSION_SYNC_SCHEDULE } from "@/collector/collection-tasks";
import type { UpstreamVersionSource } from "@/collector/version-sync";
import { writeAsset } from "@/lib/asset-writer";
import { prisma } from "@/lib/prisma";

const HEAD_SHA = "9f1c2b7d4e5a6f708192a3b4c5d6e7f8091a2b3c";
const OLD_BODY = "---\nname: demo\ndescription: 旧版本。\n---\n\n# 旧正文\n";
const NEW_BODY = "---\nname: demo\ndescription: 新版本。\n---\n\n# 新正文\n";

/** 假的上游取数实现（不打真实网络）。 */
function fakeSource(options: { headSha?: string | null } = {}): UpstreamVersionSource {
  const sha = options.headSha === undefined ? HEAD_SHA : options.headSha;

  return {
    async fetchHeadCommit() {
      if (!sha) {
        return null;
      }
      return {
        sha,
        message: "feat: 更新 demo skill",
        authoredAt: new Date("2025-11-04T09:12:44Z"),
        url: null,
      };
    },
    async fetchCommits() {
      return [
        {
          sha: HEAD_SHA,
          message: "feat: 更新 demo skill",
          authoredAt: new Date("2025-11-04T09:12:44Z"),
          url: null,
        },
      ];
    },
    async compare() {
      return {
        kind: "diff",
        aheadBy: 1,
        totalCommits: 1,
        files: [
          {
            filename: "skills/demo/SKILL.md",
            status: "modified",
            additions: 18,
            deletions: 4,
            changes: 22,
          },
        ],
        commits: [{ sha: HEAD_SHA, message: "feat: 更新 demo skill" }],
      };
    },
    async fetchFileAt() {
      return NEW_BODY;
    },
  };
}

/** 写一个上游资产（FULL 档位，有仓库信息与仓库内路径）。 */
async function seedUpstreamSkill(slug: string): Promise<string> {
  const asset = await writeAsset({
    kind: "SKILL",
    slug,
    displayName: "demo",
    license: "MIT",
    contentBody: OLD_BODY,
    summaryZh: "demo 技能。",
    summarySource: "TEMPLATE",
    repoOwner: "acme",
    repoName: "skills",
    repoUrl: "https://github.com/acme/skills",
    upstreamUrl: `https://raw.githubusercontent.com/acme/skills/main/skills/demo/SKILL.md`,
    sourceId: "github-repo",
    detail: {
      skill: {
        frontmatter: { name: "demo", description: "旧版本。" },
        skillPath: "skills/demo/SKILL.md",
      },
    },
  });

  return asset.id;
}

/** 找到版本同步那条任务。 */
function versionSyncTask(source: UpstreamVersionSource, limit = 50) {
  const task = buildCollectionTasks({ versionSource: source, versionSyncMaxAssets: limit }).find(
    (candidate) => candidate.id === "version-sync:upstream",
  );
  if (!task) {
    throw new Error("没找到版本同步任务");
  }
  return task;
}

describe("版本同步 —— 是一条自动的定时任务", () => {
  it("注册在调度器上，有自己的 cron 表达式", () => {
    const tasks = buildCollectionTasks();
    const task = tasks.find((candidate) => candidate.id === "version-sync:upstream");

    expect(task).toBeDefined();
    expect(task?.schedule).toBe(VERSION_SYNC_SCHEDULE);
    expect(task?.sourceType).toBe("version-sync");
  });

  it("每条任务的 cron 表达式互不相同（不能和别的任务撞车）", () => {
    const schedules = buildCollectionTasks().map((task) => task.schedule);
    expect(new Set(schedules).size).toBe(schedules.length);
  });

  it("cron 表达式可以用环境变量覆盖", () => {
    const original = process.env.CRON_VERSION_SYNC;
    process.env.CRON_VERSION_SYNC = "5 4 * * *";
    try {
      const task = buildCollectionTasks().find((candidate) => candidate.id === "version-sync:upstream");
      expect(task?.schedule).toBe("5 4 * * *");
    } finally {
      if (original === undefined) {
        delete process.env.CRON_VERSION_SYNC;
      } else {
        process.env.CRON_VERSION_SYNC = original;
      }
    }
  });
});

describe("版本同步 —— 跑一轮真的落库", () => {
  it("上游有新 commit 时，变更日志被生成并入库", async () => {
    const assetId = await seedUpstreamSkill("version-sync-task-new-commit");

    const result = await versionSyncTask(fakeSource()).task();

    expect(result.fetched).toBeGreaterThan(0);
    expect(result.written).toBeGreaterThan(0);
    expect(result.failed).toBe(0);

    // 版本行真的落了库。
    const versions = await prisma.assetVersion.findMany({ where: { assetId } });
    expect(versions.length).toBeGreaterThan(0);
    expect(versions.some((version) => version.version === HEAD_SHA)).toBe(true);

    // 变更摘要也被生成了（票 #16 的验收标准第 2 条）。
    const withSummary = versions.find((version) => version.version === HEAD_SHA);
    expect(withSummary?.changelog).toBeTruthy();
  });

  it("上游没有新 commit 时，不产生新的版本行", async () => {
    const assetId = await seedUpstreamSkill("version-sync-task-no-change");
    const before = await prisma.assetVersion.count({ where: { assetId } });

    // 上游的 head 就是当前记录的 commit —— 没有新东西。
    const result = await versionSyncTask(fakeSource({ headSha: null })).task();

    expect(result.failed).toBe(0);
    const after = await prisma.assetVersion.count({ where: { assetId } });
    expect(after).toBe(before);
  });

  it("一轮只扫 limit 个资产（GitHub 配额有限，不能一轮全打）", async () => {
    await seedUpstreamSkill("version-sync-task-limit-a");
    await seedUpstreamSkill("version-sync-task-limit-b");
    await seedUpstreamSkill("version-sync-task-limit-c");

    const result = await versionSyncTask(fakeSource(), 1).task();

    expect(result.fetched).toBe(1);
  });

  it("只同步 Skill：Prompt 与场景卡片没有「上游版本」，不占 GitHub 配额", async () => {
    await seedUpstreamSkill("version-sync-task-only-skill");

    // 一个有仓库信息的 Prompt（语料文件）与一张场景卡片（派生产物）。
    await writeAsset({
      kind: "PROMPT",
      slug: "version-sync-task-prompt",
      displayName: "一条提示词",
      license: "MIT",
      summaryZh: "一条提示词的简介。",
      summarySource: "TEMPLATE",
      repoOwner: "acme",
      repoName: "skills",
      repoUrl: "https://github.com/acme/skills",
      sourceId: "prompt-repo:catalog",
    });
    await writeAsset({
      kind: "SCENARIO",
      slug: "version-sync-task-card",
      displayName: "一个场景",
      license: "MIT",
      summaryZh: "一个场景的描述。",
      summarySource: "HUMAN",
      repoOwner: "acme",
      repoName: "skills",
      repoUrl: "https://github.com/acme/skills",
      sourceId: "scenario",
    });

    const result = await versionSyncTask(fakeSource()).task();

    // 扫到的只有那一个 Skill。
    expect(result.fetched).toBe(1);

    // Prompt 与场景卡片都没有版本行。
    const prompt = await prisma.asset.findUniqueOrThrow({
      where: { slug: "version-sync-task-prompt" },
    });
    const card = await prisma.asset.findUniqueOrThrow({
      where: { slug: "version-sync-task-card" },
    });
    expect(await prisma.assetVersion.count({ where: { assetId: prompt.id } })).toBe(0);
    expect(await prisma.assetVersion.count({ where: { assetId: card.id } })).toBe(0);
  });
});
