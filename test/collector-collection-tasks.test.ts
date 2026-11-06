/**
 * Seam 1 —— 采集边界（主 seam，票 #6）。
 *
 * 「**每个数据源独立 cron**，高频源与低频源节奏不同，不做统一轮询」
 * （spec 决策 4）—— 这条约束要能被测试盯住，否则很容易被改回一个统一的定时器。
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  buildCollectionTasks,
  LEADERBOARD_SCHEDULE,
  RETENTION_SCHEDULE,
  resolveSchedule,
  SITEMAP_SCHEDULE,
} from "@/collector/collection-tasks";
import { prisma } from "@/lib/prisma";
import type { GitHubRepoSourceConfig, RawItem, SourceAdapter } from "@/collector/types";
import { createScheduler } from "@/worker/scheduler";

describe("采集任务 —— 每源独立 cron", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("榜单 / 站点地图 / 保留策略各有一条自己的 cron，表达式互不相同", () => {
    const tasks = buildCollectionTasks();
    const ids = tasks.map((task) => task.id);

    expect(ids).toContain("skills.sh:leaderboard");
    expect(ids).toContain("skills.sh:sitemap");
    expect(ids).toContain("retention");

    const schedules = tasks.map((task) => task.schedule);
    expect(new Set(schedules).size).toBe(schedules.length);
  });

  it("高频源（榜单）每天一次，低频源（站点地图）每周一次", () => {
    const tasks = buildCollectionTasks();
    const leaderboard = tasks.find((task) => task.id === "skills.sh:leaderboard");
    const sitemap = tasks.find((task) => task.id === "skills.sh:sitemap");

    // 5 段 cron：分 时 日 月 周
    const fields = (expression: string) => expression.split(" ");
    expect(fields(leaderboard?.schedule ?? "")[2]).toBe("*"); // 日 = 每天
    expect(fields(sitemap?.schedule ?? "")[2]).toBe("*"); // 日 = 每天
    expect(fields(sitemap?.schedule ?? "")[4]).not.toBe("*"); // 周 = 每周某一天
  });

  it("cron 表达式可以用环境变量覆盖", () => {
    process.env.CRON_SKILLS_SH_LEADERBOARD = "5 1 * * *";
    process.env.CRON_SKILLS_SH_SITEMAP = "7 2 * * 3";

    const tasks = buildCollectionTasks();
    expect(tasks.find((task) => task.id === "skills.sh:leaderboard")?.schedule).toBe("5 1 * * *");
    expect(tasks.find((task) => task.id === "skills.sh:sitemap")?.schedule).toBe("7 2 * * 3");
  });

  it("默认值在环境变量缺失时兜底", () => {
    delete process.env.CRON_SKILLS_SH_LEADERBOARD;

    expect(resolveSchedule("CRON_SKILLS_SH_LEADERBOARD", LEADERBOARD_SCHEDULE)).toBe(
      LEADERBOARD_SCHEDULE,
    );
    expect(resolveSchedule("CRON_RETENTION", RETENTION_SCHEDULE)).toBe(RETENTION_SCHEDULE);
    expect(resolveSchedule("CRON_SKILLS_SH_SITEMAP", SITEMAP_SCHEDULE)).toBe(SITEMAP_SCHEDULE);
  });
});

describe("采集任务 —— 入库开关", () => {
  /** 一条目录条目（skills.sh 侧）。 */
  const catalogItem: RawItem = {
    slug: "acme-skills-demo",
    title: "demo",
    url: "https://www.skills.sh/acme/skills/demo",
    metadata: {
      kind: "SKILL",
      sourceId: "skills.sh",
      description: null,
      frontmatter: {},
      license: null,
      repoOwner: "acme",
      repoName: "skills",
      repoUrl: "https://github.com/acme/skills",
      upstreamUrl: null,
      skillPath: "",
      extraFiles: [],
      stars: 0,
      installs: 100,
      heatScore: 0,
      isOfficial: false,
      skillId: "demo",
      weeklyInstalls: [1, 2, 3, 4, 5, 6, 7, 8],
    },
  };

  /** 一条回源后的条目（GitHub 侧）。 */
  const githubItem: RawItem = {
    slug: "acme-skills-demo",
    title: "demo",
    url: "https://raw.githubusercontent.com/acme/skills/main/skills/demo/SKILL.md",
    content: "---\nname: demo\ndescription: A demo skill.\nlicense: MIT\n---\n\n# Demo\n",
    metadata: {
      ...catalogItem.metadata,
      sourceId: "github-repo",
      description: "A demo skill.",
      frontmatter: { name: "demo", description: "A demo skill.", license: "MIT" },
      license: "mit",
      upstreamUrl: "https://raw.githubusercontent.com/acme/skills/main/skills/demo/SKILL.md",
      skillPath: "skills/demo/SKILL.md",
      stars: 42,
    },
  };

  const catalogAdapter: SourceAdapter = {
    getName: () => "skills-sh",
    validateConfig: () => true,
    fetch: async () => ({
      source: "skills.sh:leaderboard",
      sourceType: "skills-sh",
      items: [catalogItem],
    }),
  };

  const githubAdapter: SourceAdapter<GitHubRepoSourceConfig> = {
    getName: () => "github-repo",
    validateConfig: () => true,
    fetch: async () => ({
      source: "acme/skills",
      sourceType: "github-repo",
      items: [githubItem],
    }),
  };

  it("dry-run：只采集，**不入库**", async () => {
    const tasks = buildCollectionTasks({ catalogAdapter, githubAdapter, dryRun: true });
    const leaderboard = tasks.find((task) => task.id === "skills.sh:leaderboard");

    const result = await leaderboard?.task();

    expect(result?.fetched).toBe(1);
    expect(result?.written).toBe(0);
    expect(await prisma.asset.count()).toBe(0);
  });

  it("正常模式：采到的条目真的入库", async () => {
    const tasks = buildCollectionTasks({ catalogAdapter, githubAdapter });
    const leaderboard = tasks.find((task) => task.id === "skills.sh:leaderboard");

    const result = await leaderboard?.task();

    expect(result?.fetched).toBe(1);
    expect(result?.written).toBe(1);
    expect(await prisma.asset.count()).toBe(1);

    const asset = await prisma.asset.findFirst({ where: { slug: "acme-skills-demo" } });
    expect(asset?.installs).toBe(100);
    expect(asset?.stars).toBe(42);
    expect(asset?.license).toBe("mit");
    expect(asset?.contentTier).toBe("FULL");
  });
});

describe("调度器 —— 每个任务一条独立 cron", () => {
  it("注册的任务各自按自己的表达式调度，状态可查", () => {
    const scheduler = createScheduler({ log: () => {} });
    const ran: string[] = [];

    scheduler.register({
      name: "high-frequency",
      schedule: "* * * * *",
      task: async () => {
        ran.push("high-frequency");
      },
    });
    scheduler.register({
      name: "low-frequency",
      schedule: "0 3 * * 1",
      timezone: "UTC",
      task: async () => {
        ran.push("low-frequency");
      },
    });

    const status = scheduler.status();
    expect(status).toHaveLength(2);
    expect(status[0].schedule).toBe("* * * * *");
    expect(status[1].schedule).toBe("0 3 * * 1");
    expect(status[1].timezone).toBe("UTC");
    expect(status[0].timezone).toBe("Asia/Shanghai");

    scheduler.stop();
  });

  it("任务抛错只影响它自己，调度器继续活着", async () => {
    const scheduler = createScheduler({ log: () => {} });

    scheduler.register({
      name: "broken",
      schedule: "* * * * *",
      task: async () => {
        throw new Error("炸了");
      },
    });
    scheduler.register({
      name: "fine",
      schedule: "* * * * *",
      task: async () => {
        return;
      },
    });

    await scheduler.runNow("broken");
    await scheduler.runNow("fine");

    const status = scheduler.status();
    const broken = status.find((state) => state.name === "broken");
    const fine = status.find((state) => state.name === "fine");

    expect(broken?.lastRunOk).toBe(false);
    expect(broken?.lastError).toMatch(/炸了/);
    expect(broken?.failures).toBe(1);
    expect(fine?.lastRunOk).toBe(true);

    scheduler.stop();
  });
});
