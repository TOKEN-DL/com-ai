/**
 * 上游版本同步（票 #16「版本管理与一键更新」）。
 *
 * ## 一句话
 *
 * 对有来源仓库的资产，问 GitHub「默认分支最新 commit 是哪个」，
 * 跟站内已记录的版本比：**有新 commit 就写一条版本行 + 生成变更日志 + 回写内容**。
 *
 * ## 三条硬规矩
 *
 * 1. **GitHub 不可用不能让整轮同步失败**。单条资产的取数失败 → 记一条「不可用」，
 *    继续下一条；结构变更（上游改版）→ 显式抛出 {@link SourceStructureError}。
 * 2. **只写版本元数据，不写正文副本**。版本行里存「版本号 + 变更摘要 + 正文 hash」，
 *    正文仍然只存在 `Asset.contentBody` 一处（METADATA_ONLY 档位由触发器清空）。
 * 3. **回写走 {@link updateAssetContent}**（唯一写入路径），许可证分层照旧：
 *    METADATA_ONLY 档位不回写正文，只更新版本元数据。
 *
 * ## 取数接口（port）
 *
 * 上游取数做成接口（{@link UpstreamVersionSource}），测试注入 fixture 驱动的假实现，
 * **不打真实网络**。生产实现是 {@link GitHubVersionSource}。
 */
import { createHash } from "node:crypto";

import type { ContentTier, Prisma } from "@prisma/client";

import { parseFrontmatter } from "@/collector/frontmatter";
import { SourceStructureError } from "@/collector/errors";
import type { HeadCommit } from "@/collector/github-versions";
import { updateAssetContent } from "@/lib/asset-writer";
import { prisma } from "@/lib/prisma";
import {
  summarizeCommits,
  summarizeCompare,
  summarizeInitialVersion,
  type ChangelogSummary,
  type CompareOutcome,
} from "@/lib/version-changelog";
import { isCommitSha } from "@/lib/version-format";
import { latestVersion, recordVersion } from "@/lib/version-store";

/** 上游取数接口（生产实现见 `@/collector/github-versions`）。 */
export type UpstreamVersionSource = {
  /// 取默认分支的最新 commit；仓库没有 commit 时返回 null。
  fetchHeadCommit(input: { owner: string; repo: string }): Promise<HeadCommit | null>;
  /// 取最近的若干个 commit（新在前）。
  fetchCommits(input: { owner: string; repo: string; perPage?: number }): Promise<HeadCommit[]>;
  /// 取两个 commit 之间的差异。
  compare(input: {
    owner: string;
    repo: string;
    base: string;
    head: string;
  }): Promise<CompareOutcome>;
  /// 取某个 ref 下的文件正文；取不到返回 null。
  fetchFileAt(input: {
    owner: string;
    repo: string;
    ref: string;
    path: string;
  }): Promise<string | null>;
};

/** 同步一个资产时需要的字段（够用就行，不必把整行 Asset 传进来）。 */
export type SyncableAsset = {
  id: string;
  slug: string;
  repoOwner: string | null;
  repoName: string | null;
  /// 资产当前版本（上游 sha 或平台 semver）。
  currentVersion: string | null;
  /// 内容档位（决定能不能回写正文）。
  contentTier: ContentTier;
  /// 资产在仓库内的相对路径（SKILL 才有）。
  skillPath: string | null;
};

/** 单个资产的同步结果。 */
export type SyncOutcome =
  /// 发现新版本：已记版本行 + 已回写内容。
  | {
      status: "updated";
      slug: string;
      assetId: string;
      version: string;
      changelog: string;
      /// 正文是否真的回写了（METADATA_ONLY 档位或没取到正文时为 false）。
      contentUpdated: boolean;
    }
  /// 第一次记录这个资产的上游版本。
  | {
      status: "recorded";
      slug: string;
      assetId: string;
      version: string;
      changelog: string;
      /// 正文是否真的回写了（METADATA_ONLY 档位或没取到正文时为 false）。
      contentUpdated: boolean;
    }
  /// 上游没有新提交。
  | { status: "up-to-date"; slug: string; assetId: string; version: string }
  /// 这个资产没有来源仓库信息，同步不了。
  | { status: "skipped"; slug: string; assetId: string; reason: string }
  /// 上游暂时取不到（网络 / 限流 / 仓库空了）。
  | { status: "unavailable"; slug: string; assetId: string; reason: string };

export type SyncDeps = {
  /// 上游取数实现（测试注入 fixture 驱动的假实现）。
  source?: UpstreamVersionSource;
  /// 当前时间（测试可注入）。
  now?: () => Date;
};

/** 一次同步的结果汇总。 */
export type SyncReport = {
  /// 扫描到的资产数。
  scanned: number;
  /// 发现新版本并已回写的资产数。
  updated: number;
  /// 首次记录版本的资产数。
  recorded: number;
  /// 上游没有变化的资产数。
  upToDate: number;
  /// 跳过的资产数（没有来源仓库信息）。
  skipped: number;
  /// 上游取不到、没同步成的资产数。
  unavailable: number;
  /// 失败明细（结构变更等硬错误）。
  failures: { slug: string; error: string }[];
};

/** 内容 hash（SHA-256 十六进制）。与简介生成缓存用的是同一种算法。 */
function contentHashOf(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * 同步一个资产的上游版本。
 *
 * @param asset  要同步的资产（需要它的仓库信息与当前版本）。
 * @param deps   上游取数实现与时间源。
 */
export async function syncAssetVersion(
  asset: SyncableAsset,
  deps: SyncDeps = {},
): Promise<SyncOutcome> {
  const source = deps.source;
  if (!source) {
    throw new Error("同步上游版本必须提供 source（上游取数实现）");
  }

  const owner = asset.repoOwner?.trim() ?? "";
  const repo = asset.repoName?.trim() ?? "";
  if (owner.length === 0 || repo.length === 0) {
    return { status: "skipped", slug: asset.slug, assetId: asset.id, reason: "没有来源仓库信息" };
  }

  // ─── 1. 上游最新 commit ────────────────────────────────────────────
  let head: HeadCommit | null;
  try {
    head = await source.fetchHeadCommit({ owner, repo });
  } catch (error) {
    // 结构变更必须显式失败，不能被当成「上游没变化」吞掉。
    if (error instanceof SourceStructureError) {
      throw error;
    }
    return {
      status: "unavailable",
      slug: asset.slug,
      assetId: asset.id,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (!head) {
    return {
      status: "unavailable",
      slug: asset.slug,
      assetId: asset.id,
      reason: "上游没有返回任何提交",
    };
  }

  // ─── 2. 跟已记录的版本比 ──────────────────────────────────────────
  //
  // 基准取「**已记录的上游版本**」，不是 `Asset.currentVersion`：
  // 用户发布的资产（sourceId=user）的 currentVersion 装的是平台 semver，
  // 拿它当上游基准会比出一个「永远有新版本」的假象。
  const recorded = await latestVersion(asset.id, "UPSTREAM");
  const base = recorded?.version ?? null;

  if (base === head.sha) {
    return { status: "up-to-date", slug: asset.slug, assetId: asset.id, version: head.sha };
  }

  // ─── 3. 变更日志 ──────────────────────────────────────────────────
  const summary = await buildChangelog(source, { owner, repo, base, head: head.sha });

  // ─── 4. 取新版本的正文 ────────────────────────────────────────────
  const body = await fetchBody(source, { owner, repo, ref: head.sha, path: asset.skillPath });
  const contentHash = body === null ? null : contentHashOf(body);

  // ─── 5. 记版本行（上游来源）────────────────────────────────────────
  await recordVersion({
    assetId: asset.id,
    version: head.sha,
    origin: "UPSTREAM",
    changelog: summary.text,
    contentHash,
  });

  // ─── 6. 回写内容与版本元数据 ─────────────────────────────────────
  //
  // `Asset.currentVersion` 只在「它装的是上游 sha」时才被覆盖：
  // 用户发布的资产装的是平台 semver，那才是它的对外版本号。
  const currentIsUpstream =
    asset.currentVersion === null || isCommitSha(asset.currentVersion);

  await updateAssetContent({
    slug: asset.slug,
    // 取不到正文时**不动**旧正文（undefined = 不改）。
    contentBody: body === null ? undefined : body,
    currentVersion: currentIsUpstream ? head.sha : undefined,
    upstreamUrl:
      asset.skillPath === null
        ? undefined
        : rawUrlFor(owner, repo, head.sha, asset.skillPath),
    lastSyncedAt: (deps.now ?? (() => new Date()))(),
    frontmatter: parseFrontmatterSafely(body) as Prisma.InputJsonValue | undefined,
  });

  const contentUpdated = body !== null && asset.contentTier === "FULL";

  return {
    status: base === null ? "recorded" : "updated",
    slug: asset.slug,
    assetId: asset.id,
    version: head.sha,
    changelog: summary.text,
    contentUpdated,
  };}

/**
 * 生成变更日志。
 *
 * 正常路径：Compare API 的文件级差异。
 * 降级路径：compare 取不到（404 / 限流 / 差异过大）→ 退回「最近几个提交」。
 */
async function buildChangelog(
  source: UpstreamVersionSource,
  input: { owner: string; repo: string; base: string | null; head: string },
): Promise<ChangelogSummary> {
  if (input.base === null) {
    // 第一次见这个资产：没有「上一版」可比，只能记一条初始版本。
    return summarizeInitialVersion(input.head);
  }

  const outcome = await source.compare({
    owner: input.owner,
    repo: input.repo,
    base: input.base,
    head: input.head,
  });

  if (outcome.kind !== "unavailable") {
    return summarizeCompare(outcome);
  }

  // 降级：拿不到文件级差异，至少把提交标题列出来。
  const commits = await safeFetchCommits(source, input.owner, input.repo);
  return summarizeCommits(
    commits.map((commit) => ({ sha: commit.sha, message: commit.message })),
    {
      aheadBy: commits.length,
      prefix: `上游有 ${commits.length || "若干"} 个新提交（差异详情暂不可用）。`,
    },
  );
}

/** 取最近的提交；失败返回空数组（降级路径不该再炸一次）。 */
async function safeFetchCommits(
  source: UpstreamVersionSource,
  owner: string,
  repo: string,
): Promise<HeadCommit[]> {
  try {
    return await source.fetchCommits({ owner, repo, perPage: 5 });
  } catch {
    return [];
  }
}

/** 取某个 ref 下的正文；没有路径或取不到时返回 null。 */
async function fetchBody(
  source: UpstreamVersionSource,
  input: { owner: string; repo: string; ref: string; path: string | null },
): Promise<string | null> {
  const path = input.path;
  if (path === null || path.length === 0) {
    return null;
  }
  return source.fetchFileAt({ owner: input.owner, repo: input.repo, ref: input.ref, path });
}

/** 解析 frontmatter；解析失败返回 undefined（不动旧值），不让同步失败。 */
function parseFrontmatterSafely(body: string | null): Record<string, unknown> | undefined {
  if (body === null) {
    return undefined;
  }
  try {
    return parseFrontmatter(body).data;
  } catch {
    return undefined;
  }
}

/** raw 域上的文件地址（指向具体 commit，而不是分支）。 */
function rawUrlFor(owner: string, repo: string, ref: string, path: string): string {
  const encodedPath = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(
    repo,
  )}/${encodeURIComponent(ref)}/${encodedPath}`;
}

/**
 * 同步一轮：扫所有有来源仓库的资产，逐个同步。
 *
 * **单条失败不拖垮整轮**：取数失败记进 `unavailable`，硬错误（结构变更）记进 `failures`。
 * 调用方（cron / 命令行）可以据此决定要不要报警。
 */
export async function syncUpstreamVersions(
  deps: SyncDeps & { limit?: number } = {},
): Promise<SyncReport> {
  const source = deps.source;
  if (!source) {
    throw new Error("同步上游版本必须提供 source（上游取数实现）");
  }

  const assets = await prisma.asset.findMany({
    where: {
      archivedAt: null,
      repoOwner: { not: null },
      repoName: { not: null },
    },
    orderBy: { id: "asc" },
    take: deps.limit ?? 500,
    include: { skillDetail: true },
  });

  const report: SyncReport = {
    scanned: assets.length,
    updated: 0,
    recorded: 0,
    upToDate: 0,
    skipped: 0,
    unavailable: 0,
    failures: [],
  };

  for (const asset of assets) {
    const syncable: SyncableAsset = {
      id: asset.id,
      slug: asset.slug,
      repoOwner: asset.repoOwner,
      repoName: asset.repoName,
      currentVersion: asset.currentVersion,
      contentTier: asset.contentTier,
      skillPath: asset.skillDetail?.skillPath ?? null,
    };

    try {
      const outcome = await syncAssetVersion(syncable, deps);

      if (outcome.status === "updated") report.updated += 1;
      else if (outcome.status === "recorded") report.recorded += 1;
      else if (outcome.status === "up-to-date") report.upToDate += 1;
      else if (outcome.status === "skipped") report.skipped += 1;
      else report.unavailable += 1;
    } catch (error) {
      report.failures.push({
        slug: asset.slug,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return report;
}
