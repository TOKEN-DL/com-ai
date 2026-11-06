/**
 * 版本数据的读写（票 #16「版本管理与一键更新」）。
 *
 * **上游版本与用户发布版本共用一张 `AssetVersion` 表**：
 *   - `origin = UPSTREAM` → `version` 是上游仓库的 commit sha；
 *   - `origin = PLATFORM` → `version` 是发布者声明的平台 semver。
 *
 * 「来源可区分」落在两个地方，互相兜底：
 *   1. **数据库里的 `origin` 列**（枚举，查询与展示都按它分）；
 *   2. **版本号本身的形态**（sha vs semver）—— 见 `@/lib/version-format`。
 *
 * 这个模块只碰 `AssetVersion` / `Favorite` 两张表；
 * 资产的正文与版本号回写走 `@/lib/asset-writer`（唯一写入路径）。
 */
import type { VersionOrigin } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { actorKeyFor, type InteractionActor } from "@/lib/interactions";
import { classifyVersion, shortVersionLabel } from "@/lib/version-format";

/** 一条版本记录。 */
export type VersionRecord = {
  id: string;
  assetId: string;
  /// 上游 commit sha 或平台 semver。
  version: string;
  /// 来源：上游仓库 / 平台发布。
  origin: VersionOrigin;
  /// 变更摘要（人类可读）。
  changelog: string | null;
  /// 正文 hash（不存正文副本 —— METADATA_ONLY 档位由触发器清空 snapshot）。
  contentHash: string | null;
  createdAt: Date;
};

/** 展示用的版本视图。 */
export type VersionView = {
  /// 完整版本号。
  version: string;
  /// 展示用的短版本号（sha 取前 7 位，semver 原样）。
  label: string;
  /// 来源：上游仓库 / 平台发布。
  origin: VersionOrigin;
  /// 来源的中文说明。
  originLabel: string;
  /// 版本号形态：`sha` / `semver` / `unknown`。
  shape: "sha" | "semver" | "unknown";
  /// 变更摘要。
  changelog: string | null;
  /// 版本产生时间（ISO 字符串）。
  createdAt: string;
};

/**
 * 记录一个版本。
 *
 * 幂等：同一个 `(assetId, version, origin)` 只会有一行（表上的唯一约束保证），
 * 重复同步不会把历史撑大。
 */
export async function recordVersion(input: {
  assetId: string;
  version: string;
  origin: VersionOrigin;
  changelog?: string | null;
  contentHash?: string | null;
}): Promise<VersionRecord> {
  const row = await prisma.assetVersion.upsert({
    where: {
      assetId_version_origin: {
        assetId: input.assetId,
        version: input.version,
        origin: input.origin,
      },
    },
    create: {
      assetId: input.assetId,
      version: input.version,
      origin: input.origin,
      changelog: input.changelog ?? null,
      contentHash: input.contentHash ?? null,
    },
    update: {
      // undefined = 不改这一列。已经记过的版本不覆盖历史摘要。
      changelog: input.changelog ?? undefined,
      contentHash: input.contentHash ?? undefined,
    },
  });

  return row;
}

/** 某个资产的版本历史（新版本在前）。 */
export async function listVersions(assetId: string): Promise<VersionRecord[]> {
  return prisma.assetVersion.findMany({
    where: { assetId },
    orderBy: { createdAt: "desc" },
  });
}

/** 某个资产的最新版本（可按来源过滤）。 */
export async function latestVersion(
  assetId: string,
  origin?: VersionOrigin,
): Promise<VersionRecord | null> {
  return prisma.assetVersion.findFirst({
    where: { assetId, ...(origin ? { origin } : {}) },
    orderBy: { createdAt: "desc" },
  });
}

/** 版本记录 → 展示视图。 */
export function toVersionView(record: VersionRecord): VersionView {
  return {
    version: record.version,
    label: shortVersionLabel(record.version),
    origin: record.origin,
    originLabel: record.origin === "UPSTREAM" ? "上游仓库" : "平台发布",
    shape: classifyVersion(record.version),
    changelog: record.changelog,
    createdAt: record.createdAt.toISOString(),
  };
}

/**
 * 更新提示：当前主体收藏的资产有没有出现新版本。
 *
 * ## 判定口径
 *
 * 「出现新版本」= **收藏之后**又产生了新的版本行。
 * 依据是时间比较：`AssetVersion.createdAt > Favorite.createdAt`。
 *
 * 为什么不用「装的是哪一版」：站内没有「用户安装记录」这条链路
 * （`UserInstall` 表有位置但没人写），收藏时间就是**唯一可靠的「你看到的是哪一版」**的锚点。
 *
 * ⚠️ 这个口径的已知局限：提示不会自己消失 —— 用户看过新版本之后，
 *    收藏行的时间不会变，提示会一直显示。要做到「看过即消」需要给
 *    `Favorite` 加一列「已读版本」，那是 #16 之外的改动（本期不做）。
 *
 * 游客态同样成立：收藏行按设备指纹落库（`actorKey = device:<hash>`），
 * 客户端带上 `x-device-id` 就能认出自己的收藏行。
 */
export type UpdateStatus = {
  /// 当前主体有没有收藏这个资产。
  favorited: boolean;
  /// 收藏之后有没有新版本。
  hasUpdate: boolean;
  /// 最新版本（没有版本行时为 null）。
  latestVersion: VersionView | null;
  /// 收藏时看到的版本（收藏之前最后一个版本行；没有则 null）。
  seenVersion: VersionView | null;
};

/**
 * 取某个主体对某个资产的更新提示。
 *
 * 主体认不出来（既没登录也没有设备指纹）时，返回「没收藏、没更新」——
 * 不是错误，只是不给提示。
 */
export async function getUpdateStatus(
  assetId: string,
  actor: InteractionActor | null,
): Promise<UpdateStatus> {
  const empty: UpdateStatus = {
    favorited: false,
    hasUpdate: false,
    latestVersion: null,
    seenVersion: null,
  };

  if (!actor || (!actor.userId && !actor.deviceId)) {
    return empty;
  }

  const actorKey = actorKeyFor(actor);
  const favorite = await prisma.favorite.findUnique({
    where: { assetId_actorKey: { assetId, actorKey } },
    select: { createdAt: true },
  });

  const versions = await listVersions(assetId);
  const latest = versions[0] ?? null;

  if (!favorite) {
    return { ...empty, latestVersion: latest ? toVersionView(latest) : null };
  }

  // 收藏那一刻之前的最后一个版本 = 用户「看到过」的那一版。
  const seen =
    versions.find((record) => record.createdAt.getTime() <= favorite.createdAt.getTime()) ?? null;

  const hasUpdate = latest !== null && latest.createdAt.getTime() > favorite.createdAt.getTime();

  return {
    favorited: true,
    hasUpdate,
    latestVersion: latest ? toVersionView(latest) : null,
    seenVersion: seen ? toVersionView(seen) : null,
  };
}
