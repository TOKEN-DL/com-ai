/**
 * 三档保留策略（spec 决策 4「保留策略三档」）。
 *
 *   1. **热**（窗口期内）—— 正常展示；
 *   2. **归档**（超期但高热度）—— **保留于库、前端隐藏**（`Asset.archivedAt` 非空）；
 *   3. **删除**（超期且低热度）—— **物理删除**，连同 1:1 扩展表一起删。
 *
 * 抄 `TOKEN-DL/DL-monitor` 的 `server/monitor/retention.js`（3-tier retention）：
 * 用「窗口天数」+「热度阈值」两个参数切三档，而不是按来源分别处理。
 *
 * 阈值口径：热度分是 log 量级（0 ~ 10 量级），默认 3.0 相当于
 * 「安装量上万或 star 上千」的水平 —— 高于它就值得留在库里。
 *
 * ⚠️ 归档 = **前端不可见**，但数据还在库里（还能被重新采集激活、还能查历史）。
 *    删除才是物理删除。两者都只针对**采集来的资产**（`sourceId` 非空），
 *    用户自己发布的资产不参与保留策略。
 */
import { prisma } from "@/lib/prisma";

/** 默认保留窗口（天）。 */
export const DEFAULT_WINDOW_DAYS = 30;
/** 默认归档热度阈值。 */
export const DEFAULT_ARCHIVE_HEAT = 3;

export type RetentionOptions = {
  /// 保留窗口天数；超过就是「超期」。
  windowDays?: number;
  /// 归档热度阈值；超期且热度低于它就删除。
  archiveHeatThreshold?: number;
  /// 当前时间（测试可注入）。
  now?: () => Date;
};

export type RetentionReport = {
  windowDays: number;
  archiveHeatThreshold: number;
  /// 本次检查的资产数。
  scanned: number;
  /// 本次新归档的数量。
  archived: number;
  /// 本次物理删除的数量。
  deleted: number;
  /// 从归档恢复成「热」的数量。
  unarchived: number;
  /// 窗口期内保持可见的数量。
  hot: number;
};

/** 资产的「最后同步时间」：没有同步时间就退回创建时间。 */
function syncedAt(asset: { lastSyncedAt: Date | null; createdAt: Date }): Date {
  return asset.lastSyncedAt ?? asset.createdAt;
}

/**
 * 跑一次保留策略。
 *
 * 只处理采集来的资产（`sourceId` 非空）：用户自己发布的不该被系统删掉。
 */
export async function runRetention(options: RetentionOptions = {}): Promise<RetentionReport> {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const archiveHeatThreshold = options.archiveHeatThreshold ?? DEFAULT_ARCHIVE_HEAT;
  const now = options.now ?? (() => new Date());
  const cutoff = new Date(now().getTime() - windowDays * 24 * 60 * 60 * 1000);

  const assets = await prisma.asset.findMany({
    where: { sourceId: { not: null } },
    select: {
      id: true,
      heatScore: true,
      archivedAt: true,
      lastSyncedAt: true,
      createdAt: true,
    },
  });

  const toArchive: string[] = [];
  const toDelete: string[] = [];
  let hot = 0;

  for (const asset of assets) {
    const fresh = syncedAt(asset) >= cutoff;
    if (fresh) {
      hot += 1;
      continue;
    }
    if (asset.heatScore >= archiveHeatThreshold) {
      if (asset.archivedAt === null) {
        toArchive.push(asset.id);
      }
      continue;
    }
    toDelete.push(asset.id);
  }

  if (toArchive.length > 0) {
    await prisma.asset.updateMany({
      where: { id: { in: toArchive } },
      data: { archivedAt: now() },
    });
  }

  if (toDelete.length > 0) {
    // 物理删除：Asset 上的 1:1 扩展表都是 onDelete: Cascade，跟着一起没。
    await prisma.asset.deleteMany({ where: { id: { in: toDelete } } });
  }

  // 窗口期内又变热的资产，从归档态恢复。
  const unarchived = await prisma.asset.updateMany({
    where: {
      archivedAt: { not: null },
      sourceId: { not: null },
      OR: [
        { lastSyncedAt: { gte: cutoff } },
        { lastSyncedAt: null, createdAt: { gte: cutoff } },
      ],
    },
    data: { archivedAt: null },
  });

  return {
    windowDays,
    archiveHeatThreshold,
    scanned: assets.length,
    archived: toArchive.length,
    deleted: toDelete.length,
    unarchived: unarchived.count,
    hot,
  };
}
