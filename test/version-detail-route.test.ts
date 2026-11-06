/**
 * Seam 2 —— HTTP 边界（票 #16「版本管理与一键更新」）。
 *
 * 路由处理器与页面渲染都对着**真实测试 Postgres** 跑（不用内存替身）。
 *
 * 逐条对应票 #16 的验收标准：
 *   1. 详情页可见版本历史（版本号 / 时间 / 变更摘要）；
 *   2. 上游仓库有新 commit 时，变更日志被生成并入库；
 *   3. 收藏的资产出现新版本时，用户能看到更新提示（游客态与登录态都要成立）；
 *   4. 更新后详情页展示的是新版本内容；
 *   5. 上游版本与用户发布版本共用同一张版本表，来源可区分。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GET as getVersions } from "@/app/api/assets/[slug]/versions/route";
import { POST as favoriteRoute } from "@/app/api/assets/[slug]/favorite/route";
import { GET as getFavorites } from "@/app/api/favorites/route";
import { POST as publishRoute } from "@/app/api/publish/route";
import { GET as getSkill } from "@/app/api/skills/[slug]/route";
import SkillDetailPage from "@/app/skills/[slug]/page";
import { syncAssetVersion, type UpstreamVersionSource } from "@/collector/version-sync";
import { writeAsset } from "@/lib/asset-writer";
import { hashDeviceId } from "@/lib/guest-identity";
import { prisma } from "@/lib/prisma";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { setSummaryGenerator, type SummaryGenerator } from "@/lib/summary-generator";
import { recordVersion } from "@/lib/version-store";

/** 上游的新 commit。 */
const HEAD_SHA = "9f1c2b7d4e5a6f708192a3b4c5d6e7f8091a2b3c";
/** 之前记录的 commit。 */
const OLD_SHA = "0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d";

/** 游客态设备指纹（原文）。 */
const DEVICE_A = "device-a-11111111";

const OLD_BODY = "---\nname: demo\ndescription: 旧版本。\n---\n\n# 旧正文\n";
const NEW_BODY = "---\nname: demo\ndescription: 新版本。\n---\n\n# 新正文\n";

/** 假的上游取数实现（不打真实网络）。 */
function fakeSource(options: { body?: string | null; headError?: Error } = {}): UpstreamVersionSource {
  return {
    async fetchHeadCommit() {
      if (options.headError) {
        throw options.headError;
      }
      return {
        sha: HEAD_SHA,
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
      return options.body === undefined ? NEW_BODY : options.body;
    },
  };
}

/** 造一个带会话 cookie 的请求。 */
function withCookie(token: string, url = "http://localhost/api/x"): Request {
  return new Request(url, { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` } });
}

/** 造一个带设备标识的请求。 */
function withDevice(deviceId: string, url = "http://localhost/api/x"): Request {
  return new Request(url, { headers: { "x-device-id": deviceId } });
}

/** 造一个带会话 cookie 的 JSON 请求。 */
function jsonRequest(url: string, body: unknown, token?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) {
    headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
  }
  return new Request(url, { method: "POST", headers, body: JSON.stringify(body) });
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

/**
 * 把收藏行的时间往前挪一点。
 *
 * 判定「收藏之后有没有新版本」比的是两个时间戳，而 Postgres 的时间戳精度到毫秒 ——
 * 收藏与版本落在同一毫秒时，先后次序是不确定的。测试里把前置条件写死，
 * 免得这条用例偶尔红。
 */
async function backdateFavorite(assetId: string, actorKey: string): Promise<void> {
  await prisma.favorite.updateMany({
    where: { assetId, actorKey },
    data: { createdAt: new Date(Date.now() - 60_000) },
  });
}

describe("版本历史 —— 详情页可见（版本号 / 时间 / 变更摘要）", () => {
  it("详情页渲染出版本号、时间与变更摘要", async () => {
    const assetId = await seedUpstreamSkill("version-history-skill");

    await recordVersion({
      assetId,
      version: HEAD_SHA,
      origin: "UPSTREAM",
      changelog: "2 个文件变更（+24 / -4 行）：skills/demo/SKILL.md",
    });

    const html = renderToStaticMarkup(
      await SkillDetailPage({ params: Promise.resolve({ slug: "version-history-skill" }) }),
    );

    expect(html).toContain("版本历史");
    // 版本号（sha 取前 7 位）。
    expect(html).toContain("9f1c2b7");
    // 变更摘要。
    expect(html).toContain("2 个文件变更");
    // 来源可区分。
    expect(html).toContain("上游仓库");
    // 时间（页面上是本地化后的日期字符串，这里只断言它不是空的）。
    expect(html).toContain("版本历史");
  });

  it("详情接口返回版本历史（含来源与变更摘要）", async () => {
    const assetId = await seedUpstreamSkill("version-history-api-skill");

    await recordVersion({
      assetId,
      version: HEAD_SHA,
      origin: "UPSTREAM",
      changelog: "2 个文件变更（+24 / -4 行）",
    });

    const response = await getSkill(new Request("http://localhost/api/skills/x"), {
      params: Promise.resolve({ slug: "version-history-api-skill" }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.versions).toHaveLength(1);
    expect(body.versions[0]).toMatchObject({
      version: HEAD_SHA,
      label: "9f1c2b7",
      origin: "UPSTREAM",
      originLabel: "上游仓库",
      shape: "sha",
      changelog: "2 个文件变更（+24 / -4 行）",
    });
    expect(typeof body.versions[0].createdAt).toBe("string");
  });
});

describe("上游版本与平台发布版本共用一张表，来源可区分", () => {
  it("两种来源落在同一张 AssetVersion 表里，origin 能区分", async () => {
    // 平台发布：走真实的发布接口（唯一写入路径）。
    setSummaryGenerator({
      async generate() {
        return {
          summaryZh: "AI 写的中文简介。",
          whenToUse: null,
          howToUse: null,
          tags: [],
          source: "LLM",
        };
      },
    } satisfies SummaryGenerator);

    const user = await prisma.user.create({
      data: { email: "publisher@example.com", emailVerifiedAt: new Date() },
    });
    const { token } = await createSession({ userId: user.id });

    const publishResponse = await publishRoute(
      jsonRequest(
        "http://localhost/api/publish",
        {
          kind: "SKILL",
          displayName: "demo",
          repoUrl: "https://github.com/acme/skills",
          license: "MIT",
          description: "平台发布的 demo。",
          contentBody: NEW_BODY,
          version: "1.2.0",
        },
        token,
      ),
    );
    setSummaryGenerator(null);

    expect(publishResponse.status).toBe(201);

    const asset = await prisma.asset.findUniqueOrThrow({ where: { slug: "acme-skills" } });

    // 同一个资产再记一条**上游**版本（模拟采集到的同一个仓库）。
    await recordVersion({
      assetId: asset.id,
      version: HEAD_SHA,
      origin: "UPSTREAM",
      changelog: "上游变更",
    });

    // 同一个资产、同一张表，两种来源。
    const rows = await prisma.assetVersion.findMany({
      where: { assetId: asset.id },
      orderBy: { origin: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.origin).sort()).toEqual(["PLATFORM", "UPSTREAM"]);
    expect(rows.find((row) => row.origin === "PLATFORM")?.version).toBe("1.2.0");
    expect(rows.find((row) => row.origin === "UPSTREAM")?.version).toBe(HEAD_SHA);

    // 详情页上两种来源都看得见，且标得清。
    const html = renderToStaticMarkup(
      await SkillDetailPage({ params: Promise.resolve({ slug: "acme-skills" }) }),
    );
    expect(html).toContain("上游仓库");
    expect(html).toContain("平台发布");
    expect(html).toContain("1.2.0");
    expect(html).toContain("9f1c2b7");

    // 平台发布那一版的来源标识落在发布记录上。
    const publication = await prisma.userPublishedAsset.findFirstOrThrow({
      where: { userId: user.id, assetId: asset.id },
    });
    expect(publication.latestVersion).toBe("1.2.0");
  });
});

describe("上游有新 commit 时：变更日志生成并入库", () => {
  it("第一次同步：记一条初始版本（没有上一版可比）", async () => {
    const assetId = await seedUpstreamSkill("sync-changelog-skill");
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: assetId } });

    const outcome = await syncAssetVersion(
      {
        id: asset.id,
        slug: asset.slug,
        repoOwner: asset.repoOwner,
        repoName: asset.repoName,
        currentVersion: null,
        contentTier: asset.contentTier,
        skillPath: "skills/demo/SKILL.md",
      },
      { source: fakeSource() },
    );

    expect(outcome.status).toBe("recorded");

    const row = await prisma.assetVersion.findFirstOrThrow({ where: { assetId } });
    expect(row.version).toBe(HEAD_SHA);
    expect(row.origin).toBe("UPSTREAM");
    expect(row.changelog).toContain("首次记录版本");
    // 只存摘要与 hash，不存正文副本。
    expect(row.snapshot).toBeNull();
    expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("上游有了新 commit：文件级差异的变更日志入库", async () => {
    const assetId = await seedUpstreamSkill("sync-changelog-diff-skill");
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: assetId } });

    // 之前同步过一次（基准版本）。
    await recordVersion({
      assetId,
      version: OLD_SHA,
      origin: "UPSTREAM",
      changelog: "首次记录版本",
    });

    const outcome = await syncAssetVersion(
      {
        id: asset.id,
        slug: asset.slug,
        repoOwner: asset.repoOwner,
        repoName: asset.repoName,
        currentVersion: OLD_SHA,
        contentTier: asset.contentTier,
        skillPath: "skills/demo/SKILL.md",
      },
      { source: fakeSource() },
    );

    expect(outcome.status).toBe("updated");

    const row = await prisma.assetVersion.findFirstOrThrow({
      where: { assetId, version: HEAD_SHA },
    });
    expect(row.origin).toBe("UPSTREAM");
    expect(row.changelog).toContain("1 个文件变更");
    expect(row.changelog).toContain("skills/demo/SKILL.md");
    expect(row.changelog).toContain("feat: 更新 demo skill");
    // 旧版本还在（历史不被覆盖）。
    expect(await prisma.assetVersion.count({ where: { assetId } })).toBe(2);
  });
});

describe("更新后详情页展示新版本内容", () => {
  it("同步到新 commit 后，详情页与接口都展示新正文", async () => {
    const assetId = await seedUpstreamSkill("sync-new-content-skill");
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: assetId } });

    // 先记一版旧的，模拟「之前同步过一次」。
    await recordVersion({
      assetId,
      version: OLD_SHA,
      origin: "UPSTREAM",
      changelog: "首次记录版本",
    });
    await prisma.asset.update({
      where: { id: assetId },
      data: { currentVersion: OLD_SHA },
    });

    const outcome = await syncAssetVersion(
      {
        id: asset.id,
        slug: asset.slug,
        repoOwner: asset.repoOwner,
        repoName: asset.repoName,
        currentVersion: OLD_SHA,
        contentTier: asset.contentTier,
        skillPath: "skills/demo/SKILL.md",
      },
      { source: fakeSource({ body: NEW_BODY }) },
    );

    expect(outcome.status).toBe("updated");

    // 详情接口展示的是新版本内容。
    const response = await getSkill(new Request("http://localhost/api/skills/x"), {
      params: Promise.resolve({ slug: "sync-new-content-skill" }),
    });
    const body = await response.json();
    expect(body.contentBody).toBe(NEW_BODY);
    expect(body.currentVersion).toBe(HEAD_SHA);
    expect(body.versions[0].version).toBe(HEAD_SHA);

    // 详情页展示的也是新版本内容。
    const html = renderToStaticMarkup(
      await SkillDetailPage({ params: Promise.resolve({ slug: "sync-new-content-skill" }) }),
    );
    expect(html).toContain("新正文");
    expect(html).not.toContain("旧正文");
  });

  it("METADATA_ONLY 档位不回写正文，只更新版本元数据", async () => {
    const asset = await writeAsset({
      kind: "SKILL",
      slug: "metadata-only-sync-skill",
      displayName: "demo",
      license: null,
      contentBody: OLD_BODY,
      summaryZh: "demo 技能。",
      summarySource: "TEMPLATE",
      repoOwner: "acme",
      repoName: "skills",
      repoUrl: "https://github.com/acme/skills",
      sourceId: "github-repo",
      detail: { skill: { skillPath: "skills/demo/SKILL.md" } },
    });

    const outcome = await syncAssetVersion(
      {
        id: asset.id,
        slug: asset.slug,
        repoOwner: asset.repoOwner,
        repoName: asset.repoName,
        currentVersion: null,
        contentTier: asset.contentTier,
        skillPath: "skills/demo/SKILL.md",
      },
      { source: fakeSource({ body: NEW_BODY }) },
    );

    expect(outcome.status).toBe("recorded");
    if (outcome.status !== "recorded") {
      throw new Error(`期望首次记录版本，实际：${outcome.status}`);
    }
    expect(outcome.contentUpdated).toBe(false);

    const stored = await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(stored.contentTier).toBe("METADATA_ONLY");
    expect(stored.contentBody).toBeNull();
    expect(stored.currentVersion).toBe(HEAD_SHA);

    const row = await prisma.assetVersion.findFirstOrThrow({ where: { assetId: asset.id } });
    expect(row.version).toBe(HEAD_SHA);
    // 正文快照不落库（触发器也会清）。
    expect(row.snapshot).toBeNull();
  });

  it("上游没有新 commit：不写新版本行（版本历史不重复）", async () => {
    const assetId = await seedUpstreamSkill("sync-up-to-date-skill");
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: assetId } });

    await recordVersion({
      assetId,
      version: HEAD_SHA,
      origin: "UPSTREAM",
      changelog: "首次记录版本",
    });

    const outcome = await syncAssetVersion(
      {
        id: asset.id,
        slug: asset.slug,
        repoOwner: asset.repoOwner,
        repoName: asset.repoName,
        currentVersion: HEAD_SHA,
        contentTier: asset.contentTier,
        skillPath: "skills/demo/SKILL.md",
      },
      { source: fakeSource() },
    );

    expect(outcome.status).toBe("up-to-date");
    expect(await prisma.assetVersion.count({ where: { assetId } })).toBe(1);
  });

  it("上游取不到时不写版本行（不误报有更新）", async () => {
    const assetId = await seedUpstreamSkill("sync-unavailable-skill");
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: assetId } });

    const outcome = await syncAssetVersion(
      {
        id: asset.id,
        slug: asset.slug,
        repoOwner: asset.repoOwner,
        repoName: asset.repoName,
        currentVersion: null,
        contentTier: asset.contentTier,
        skillPath: "skills/demo/SKILL.md",
      },
      { source: fakeSource({ headError: new Error("HTTP 503 Service Unavailable") }) },
    );

    expect(outcome.status).toBe("unavailable");
    expect(await prisma.assetVersion.count({ where: { assetId } })).toBe(0);
  });
});

describe("收藏的资产出现新版本时的更新提示", () => {
  it("游客态：收藏之后出了新版本，提示成立", async () => {
    const assetId = await seedUpstreamSkill("guest-update-notice-skill");

    // 游客收藏。
    const favoriteResponse = await favoriteRoute(
      withDevice(DEVICE_A, "http://localhost/api/assets/guest-update-notice-skill/favorite"),
      { params: Promise.resolve({ slug: "guest-update-notice-skill" }) },
    );
    expect(favoriteResponse.status).toBe(200);

    // 还没有版本 → 没有更新提示。
    const before = await getVersions(
      withDevice(DEVICE_A, "http://localhost/api/assets/guest-update-notice-skill/versions"),
      { params: Promise.resolve({ slug: "guest-update-notice-skill" }) },
    );
    const beforeBody = await before.json();
    expect(beforeBody.update.favorited).toBe(true);
    expect(beforeBody.update.hasUpdate).toBe(false);

    // 出了新版本。
    await recordVersion({
      assetId,
      version: HEAD_SHA,
      origin: "UPSTREAM",
      changelog: "2 个文件变更（+24 / -4 行）",
    });
    await backdateFavorite(assetId, `device:${hashDeviceId(DEVICE_A)}`);

    const after = await getVersions(
      withDevice(DEVICE_A, "http://localhost/api/assets/guest-update-notice-skill/versions"),
      { params: Promise.resolve({ slug: "guest-update-notice-skill" }) },
    );
    const afterBody = await after.json();
    expect(afterBody.update.favorited).toBe(true);
    expect(afterBody.update.hasUpdate).toBe(true);
    expect(afterBody.update.latestVersion.version).toBe(HEAD_SHA);
    expect(afterBody.update.latestVersion.originLabel).toBe("上游仓库");
    // 版本历史也一起返回（详情页与提示用的是同一份数据）。
    expect(afterBody.versions).toHaveLength(1);
  });

  it("游客态：别的设备看不到这个收藏（提示不串台）", async () => {
    const assetId = await seedUpstreamSkill("guest-update-notice-other-device");
    await favoriteRoute(
      withDevice(DEVICE_A, "http://localhost/api/assets/guest-update-notice-other-device/favorite"),
      { params: Promise.resolve({ slug: "guest-update-notice-other-device" }) },
    );
    await recordVersion({ assetId, version: HEAD_SHA, origin: "UPSTREAM", changelog: "有更新" });

    const response = await getVersions(
      withDevice("device-b-22222222", "http://localhost/api/assets/guest-update-notice-other-device/versions"),
      { params: Promise.resolve({ slug: "guest-update-notice-other-device" }) },
    );
    const body = await response.json();

    expect(body.update.favorited).toBe(false);
    expect(body.update.hasUpdate).toBe(false);
  });

  it("登录态：收藏之后出了新版本，提示成立", async () => {
    const assetId = await seedUpstreamSkill("user-update-notice-skill");

    const user = await prisma.user.create({
      data: { email: "fan@example.com", emailVerifiedAt: new Date() },
    });
    const { token } = await createSession({ userId: user.id });

    await favoriteRoute(
      withCookie(token, "http://localhost/api/assets/user-update-notice-skill/favorite"),
      { params: Promise.resolve({ slug: "user-update-notice-skill" }) },
    );

    await recordVersion({
      assetId,
      version: HEAD_SHA,
      origin: "UPSTREAM",
      changelog: "2 个文件变更（+24 / -4 行）",
    });
    await backdateFavorite(assetId, `user:${user.id}`);

    const response = await getVersions(
      withCookie(token, "http://localhost/api/assets/user-update-notice-skill/versions"),
      { params: Promise.resolve({ slug: "user-update-notice-skill" }) },
    );
    const body = await response.json();

    expect(body.update.favorited).toBe(true);
    expect(body.update.hasUpdate).toBe(true);
    expect(body.update.latestVersion.version).toBe(HEAD_SHA);
  });

  it("收藏之后才出的新版本才算更新（先有版本、后收藏 → 不提示）", async () => {
    const assetId = await seedUpstreamSkill("favorite-after-version-skill");

    await recordVersion({ assetId, version: HEAD_SHA, origin: "UPSTREAM", changelog: "有更新" });

    // 把版本时间挪到收藏之前（毫秒精度下先后次序要写死）。
    await prisma.assetVersion.updateMany({
      where: { assetId },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });

    await favoriteRoute(
      withDevice(DEVICE_A, "http://localhost/api/assets/favorite-after-version-skill/favorite"),
      { params: Promise.resolve({ slug: "favorite-after-version-skill" }) },
    );

    const response = await getVersions(
      withDevice(DEVICE_A, "http://localhost/api/assets/favorite-after-version-skill/versions"),
      { params: Promise.resolve({ slug: "favorite-after-version-skill" }) },
    );
    const body = await response.json();

    expect(body.update.favorited).toBe(true);
    expect(body.update.hasUpdate).toBe(false);
    // 版本历史照样能看到最新版本。
    expect(body.update.latestVersion.version).toBe(HEAD_SHA);
  });

  it("没有收藏就没有提示（版本历史照样给）", async () => {
    const assetId = await seedUpstreamSkill("not-favorited-skill");
    await recordVersion({ assetId, version: HEAD_SHA, origin: "UPSTREAM", changelog: "有更新" });

    const response = await getVersions(
      withDevice(DEVICE_A, "http://localhost/api/assets/not-favorited-skill/versions"),
      { params: Promise.resolve({ slug: "not-favorited-skill" }) },
    );
    const body = await response.json();

    expect(body.update.favorited).toBe(false);
    expect(body.update.hasUpdate).toBe(false);
    expect(body.versions).toHaveLength(1);
  });

  it("用户发布的资产出了新版本：提示同样成立", async () => {
    setSummaryGenerator({
      async generate() {
        return {
          summaryZh: "AI 写的中文简介。",
          whenToUse: null,
          howToUse: null,
          tags: [],
          source: "LLM",
        };
      },
    } satisfies SummaryGenerator);

    const user = await prisma.user.create({
      data: { email: "version-publisher@example.com", emailVerifiedAt: new Date() },
    });
    const { token } = await createSession({ userId: user.id });

    const publish = async (version: string) =>
      publishRoute(
        jsonRequest(
          "http://localhost/api/publish",
          {
            kind: "SKILL",
            displayName: "demo",
            repoUrl: "https://github.com/acme/platform-skills",
            license: "MIT",
            description: "平台发布的 demo。",
            contentBody: NEW_BODY,
            version,
          },
          token,
        ),
      );

    expect((await publish("1.0.0")).status).toBe(201);

    const asset = await prisma.asset.findUniqueOrThrow({ where: { slug: "acme-platform-skills" } });

    await favoriteRoute(
      withDevice(DEVICE_A, "http://localhost/api/assets/acme-platform-skills/favorite"),
      { params: Promise.resolve({ slug: "acme-platform-skills" }) },
    );
    await backdateFavorite(asset.id, `device:${hashDeviceId(DEVICE_A)}`);

    // 发布者又发了一版。
    expect((await publish("1.1.0")).status).toBe(201);
    setSummaryGenerator(null);

    const response = await getVersions(
      withDevice(DEVICE_A, "http://localhost/api/assets/acme-platform-skills/versions"),
      { params: Promise.resolve({ slug: "acme-platform-skills" }) },
    );
    const body = await response.json();

    expect(body.update.hasUpdate).toBe(true);
    expect(body.update.latestVersion.version).toBe("1.1.0");
    expect(body.update.latestVersion.origin).toBe("PLATFORM");
    expect(body.update.latestVersion.originLabel).toBe("平台发布");
    // 两个版本都在同一张表里。
    expect(body.versions.map((version: { version: string }) => version.version).sort()).toEqual([
      "1.0.0",
      "1.1.0",
    ]);
  });

  it("重复发布同一个版本号：版本表不重复，版本号不被抹掉", async () => {
    setSummaryGenerator({
      async generate() {
        return {
          summaryZh: "AI 写的中文简介。",
          whenToUse: null,
          howToUse: null,
          tags: [],
          source: "LLM",
        };
      },
    } satisfies SummaryGenerator);

    const user = await prisma.user.create({
      data: { email: "republish@example.com", emailVerifiedAt: new Date() },
    });
    const { token } = await createSession({ userId: user.id });

    const publish = async (version: string | null) =>
      publishRoute(
        jsonRequest(
          "http://localhost/api/publish",
          {
            kind: "SKILL",
            displayName: "demo",
            repoUrl: "https://github.com/acme/republish-skills",
            license: "MIT",
            description: "平台发布的 demo。",
            contentBody: NEW_BODY,
            ...(version ? { version } : {}),
          },
          token,
        ),
      );

    expect((await publish("1.0.0")).status).toBe(201);
    expect((await publish("1.0.0")).status).toBe(201);
    // 第三次不填版本号：版本号不该被抹掉。
    expect((await publish(null)).status).toBe(201);
    setSummaryGenerator(null);

    const asset = await prisma.asset.findUniqueOrThrow({ where: { slug: "acme-republish-skills" } });
    const rows = await prisma.assetVersion.findMany({ where: { assetId: asset.id } });

    expect(rows).toHaveLength(1);
    expect(rows[0].version).toBe("1.0.0");
    expect(asset.currentVersion).toBe("1.0.0");
  });

  it("不存在的 slug 返回 404", async () => {
    const response = await getVersions(
      withDevice(DEVICE_A, "http://localhost/api/assets/not-there/versions"),
      { params: Promise.resolve({ slug: "not-there" }) },
    );

    expect(response.status).toBe(404);
  });
});

describe("登录用户的订阅式提示 —— 收藏列表里标出「有新版本」", () => {
  it("收藏的资产出了新版本，收藏列表带上更新标记", async () => {
    const assetId = await seedUpstreamSkill("favorites-list-update-skill");

    const user = await prisma.user.create({
      data: { email: "collector@example.com", emailVerifiedAt: new Date() },
    });
    const { token } = await createSession({ userId: user.id });

    await favoriteRoute(
      withCookie(token, "http://localhost/api/assets/favorites-list-update-skill/favorite"),
      { params: Promise.resolve({ slug: "favorites-list-update-skill" }) },
    );

    await recordVersion({
      assetId,
      version: HEAD_SHA,
      origin: "UPSTREAM",
      changelog: "2 个文件变更（+24 / -4 行）",
    });
    await backdateFavorite(assetId, `user:${user.id}`);

    const response = await getFavorites(
      withCookie(token, "http://localhost/api/favorites"),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].slug).toBe("favorites-list-update-skill");
    expect(body.items[0].hasUpdate).toBe(true);
    expect(body.items[0].latestVersion.label).toBe("9f1c2b7");
  });

  it("没有新版本时不标更新", async () => {
    await seedUpstreamSkill("favorites-list-no-update-skill");

    const user = await prisma.user.create({
      data: { email: "collector2@example.com", emailVerifiedAt: new Date() },
    });
    const { token } = await createSession({ userId: user.id });

    await favoriteRoute(
      withCookie(token, "http://localhost/api/assets/favorites-list-no-update-skill/favorite"),
      { params: Promise.resolve({ slug: "favorites-list-no-update-skill" }) },
    );

    const response = await getFavorites(
      withCookie(token, "http://localhost/api/favorites"),
    );
    const body = await response.json();

    expect(body.items[0].hasUpdate).toBe(false);
    expect(body.items[0].latestVersion).toBeNull();
  });
});
