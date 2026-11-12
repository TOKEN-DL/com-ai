/**
 * 用户发布资产的审核链路（票 #11）。
 *
 * spec 决策 11：审核链路 = **自动关键词过滤 → 用户举报 → 人工抽查**，
 * **不做全量预审队列**（单人运营下预审会立刻成为瓶颈）。
 *
 * 状态机（与 publish-service.ts 里那张图一一对应）：
 *
 *   PENDING  审核中 —— 命中自动过滤或被举报，已下架，等人工抽查
 *   PUBLISHED 已发布 —— 默认状态，对外可见
 *   REJECTED 已拒绝 —— 运营判定违规，已下架，审核意见对发布者可见
 *
 * 转换只有三条，全部由运营动作驱动：
 *   PENDING  --放行-->  PUBLISHED
 *   PENDING  --驳回-->  REJECTED
 *   PUBLISHED --驳回-->  REJECTED（抽查发现违规）
 *   REJECTED --放行-->  PUBLISHED（改判）
 *
 * 被下架的资产**对外不可见**（列表与详情都过滤掉），但发布者自己仍然看得到
 * 状态与审核意见。
 */
import type {
  AssetKind,
  ContentTier,
  Prisma,
  PublishStatus,
  ReportReason,
  ReportStatus,
  SummarySource,
} from "@prisma/client";

import { prisma } from "@/lib/prisma";

/** 审核状态的中文名（页面与接口共用一份，别处各写一遍）。 */
export const PUBLISH_STATUS_LABELS: Record<PublishStatus, string> = {
  PENDING: "审核中",
  PUBLISHED: "已发布",
  REJECTED: "已拒绝",
};

/** 审核状态的中文说明（给发布者看的）。 */
export const PUBLISH_STATUS_HINTS: Record<PublishStatus, string> = {
  PENDING: "已下架，等待运营抽查。",
  PUBLISHED: "已对外可见。",
  REJECTED: "已下架，审核意见见下。",
};

/** 一条发布记录的视图模型（页面与接口读同一份）。 */
export type PublishedAssetView = {
  /// 发布记录 id（审核时用它）。
  id: string;
  /// 资产 slug。
  slug: string;
  /// 展示名。
  displayName: string;
  /// 资产类型。
  kind: AssetKind;
  /// 审核状态。
  status: PublishStatus;
  /// 审核状态的中文名。
  statusLabel: string;
  /// 审核状态的中文说明。
  statusHint: string;
  /// 审核意见（运营写给发布者看的话）。
  reviewNote: string | null;
  /// 命中自动过滤的原因。
  filteredReason: string | null;
  /// 累计被举报次数。
  reportedCount: number;
  /// 发布时间（ISO 字符串）。
  publishedAt: string;
  /// 最近一次审核时间。
  reviewedAt: string | null;
  /// SPDX 许可证 id。
  license: string | null;
  /// 内容档位。
  contentTier: ContentTier;
  /// 简介来源标记：LLM = AI 生成初稿；HUMAN = 用户自己写的；TEMPLATE = 模板降级。
  summarySource: SummarySource | null;
  /// 中文简介。
  summaryZh: string | null;
  /// 「何时用」。
  whenToUse: string | null;
  /// 「怎么用」。
  howToUse: string | null;
  /// 仓库地址。
  repoUrl: string | null;
  /// 仓库 owner / name。
  repoOwner: string | null;
  repoName: string | null;
  /// 发布者声明的版本号（二期 #16 预留）。
  version: string | null;
  /// 依赖清单路径（二期 #17 预留）。
  manifestPath: string | null;
};

type PublicationRow = Prisma.UserPublishedAssetGetPayload<{
  include: { asset: { include: { skillDetail: true } } };
}>;

/** 发布记录 + 资产 → 视图模型。 */
function toView(row: PublicationRow): PublishedAssetView {
  const asset = row.asset;
  return {
    id: row.id,
    slug: asset.slug,
    displayName: asset.displayName,
    kind: asset.kind,
    status: row.status,
    statusLabel: PUBLISH_STATUS_LABELS[row.status],
    statusHint: PUBLISH_STATUS_HINTS[row.status],
    reviewNote: row.reviewNote,
    filteredReason: row.filteredReason,
    reportedCount: row.reportedCount,
    publishedAt: row.publishedAt.toISOString(),
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    license: asset.license,
    contentTier: asset.contentTier,
    summarySource: asset.summarySource,
    summaryZh: asset.summaryZh,
    whenToUse: asset.skillDetail?.whenToUse ?? null,
    howToUse: asset.skillDetail?.howToUse ?? null,
    repoUrl: asset.repoUrl,
    repoOwner: asset.repoOwner,
    repoName: asset.repoName,
    version: row.latestVersion,
    manifestPath: row.manifestPath,
  };
}

/** 列表查询用的 include。 */
const PUBLICATION_INCLUDE = {
  asset: { include: { skillDetail: true } },
} satisfies Prisma.UserPublishedAssetInclude;

/**
 * 「我的发布」列表。
 *
 * 按发布时间倒序 —— 发布者最关心的是自己刚发的那条。
 */
export async function listMyPublications(userId: string): Promise<PublishedAssetView[]> {
  const rows = await prisma.userPublishedAsset.findMany({
    where: { userId },
    include: PUBLICATION_INCLUDE,
    orderBy: { publishedAt: "desc" },
  });
  return rows.map(toView);
}

/**
 * 运营抽查列表。
 *
 * 默认只看待处理的（PENDING）—— 抽查是「有空就翻翻」，
 * 不是每天必须清空一个队列（那正是全量预审队列的毛病）。
 */
export async function listPublicationsForReview(options: {
  status?: PublishStatus;
  limit?: number;
}): Promise<PublishedAssetView[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const rows = await prisma.userPublishedAsset.findMany({
    where: options.status ? { status: options.status } : {},
    include: PUBLICATION_INCLUDE,
    orderBy: [{ reportedCount: "desc" }, { publishedAt: "desc" }],
    take: limit,
  });
  return rows.map(toView);
}

/** 审核动作。 */
export type ReviewAction = "approve" | "reject";

export type ReviewResult =
  | { ok: true; view: PublishedAssetView }
  | { ok: false; error: "not_found" | "invalid_note" };

/**
 * 运营审核一条发布记录。
 *
 * - `approve`（放行 / 改判）：状态 → PUBLISHED，资产重新对外可见；
 * - `reject`（驳回 / 下架）：状态 → REJECTED，**必须写审核意见** ——
 *   发布者有权知道为什么被拒。
 */
export async function reviewPublication(input: {
  publicationId: string;
  action: ReviewAction;
  note?: string | null;
  reviewerId: string;
}): Promise<ReviewResult> {
  const note = (input.note ?? "").trim();
  if (input.action === "reject" && note.length === 0) {
    return { ok: false, error: "invalid_note" };
  }

  const status: PublishStatus = input.action === "approve" ? "PUBLISHED" : "REJECTED";

  const updated = await prisma.userPublishedAsset.updateMany({
    where: { id: input.publicationId },
    data: {
      status,
      reviewNote: note.length > 0 ? note : null,
      reviewedAt: new Date(),
      reviewedBy: input.reviewerId,
    },
  });

  if (updated.count === 0) {
    return { ok: false, error: "not_found" };
  }

  const row = await prisma.userPublishedAsset.findUniqueOrThrow({
    where: { id: input.publicationId },
    include: PUBLICATION_INCLUDE,
  });
  return { ok: true, view: toView(row) };
}

/** 允许举报的理由。 */
export const PUBLISH_REPORT_REASONS: readonly ReportReason[] = [
  "SPAM",
  "ILLEGAL",
  "COPYRIGHT",
  "INFRINGING",
  "OFFENSIVE",
  "OTHER",
];

/** 举报理由的中文名。 */
export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  SPAM: "垃圾广告",
  ILLEGAL: "违法违规",
  COPYRIGHT: "侵犯版权",
  INFRINGING: "侵权",
  OFFENSIVE: "冒犯性内容",
  OTHER: "其他",
};

export type ReportResult =
  | { ok: true; reportId: string; publicationStatus: PublishStatus | null }
  | { ok: false; error: "not_found" | "invalid_reason" };

/**
 * 举报一个资产。
 *
 * 游客也能举报（spec 约束 7：注册墙只出现在「发布自己的资产」与「跨设备同步安装清单」两处）。
 *
 * 命中后：资产若是**用户发布**的，立即下架（状态 → PENDING，等运营抽查）；
 * 已被采集收录的资产不在本票的处理范围（#10 的举报链路负责），这里只落举报记录。
 */
export async function reportPublishedAsset(input: {
  assetSlug: string;
  reason: ReportReason;
  detail?: string | null;
  reporterUserId?: string | null;
}): Promise<ReportResult> {
  if (!PUBLISH_REPORT_REASONS.includes(input.reason)) {
    return { ok: false, error: "invalid_reason" };
  }

  const asset = await prisma.asset.findUnique({
    where: { slug: input.assetSlug },
    include: { publishedBy: true },
  });
  if (!asset) {
    return { ok: false, error: "not_found" };
  }

  const report = await prisma.report.create({
    data: {
      target: "ASSET",
      assetId: asset.id,
      reporterUserId: input.reporterUserId ?? null,
      reason: input.reason,
      detail: (input.detail ?? "").trim() || null,
    },
  });

  const publication = asset.publishedBy[0] ?? null;
  if (!publication) {
    return { ok: true, reportId: report.id, publicationStatus: null };
  }

  // 用户发布 → 被举报即下架，等人工抽查。
  const updated = await prisma.userPublishedAsset.update({
    where: { id: publication.id },
    data: {
      status: "PENDING",
      reportedCount: { increment: 1 },
    },
  });

  return { ok: true, reportId: report.id, publicationStatus: updated.status };
}

/** 一条举报的视图模型。 */
export type ReportView = {
  id: string;
  target: string;
  assetId: string | null;
  assetSlug: string | null;
  assetDisplayName: string | null;
  reason: ReportReason;
  reasonLabel: string;
  detail: string | null;
  status: ReportStatus;
  createdAt: string;
  resolvedAt: string | null;
};

/** 举报 → 视图模型。 */
function toReportView(row: Prisma.ReportGetPayload<{ include: { asset: true } }>): ReportView {
  return {
    id: row.id,
    target: row.target,
    assetId: row.assetId,
    assetSlug: row.asset?.slug ?? null,
    assetDisplayName: row.asset?.displayName ?? null,
    reason: row.reason,
    reasonLabel: REPORT_REASON_LABELS[row.reason],
    detail: row.detail,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
  };
}

/** 待处理的举报列表（运营抽查用）。 */
export async function listReports(options: { status?: ReportStatus }): Promise<ReportView[]> {
  const rows = await prisma.report.findMany({
    where: options.status ? { status: options.status } : {},
    include: { asset: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return rows.map(toReportView);
}

export type ResolveReportResult =
  | { ok: true; view: ReportView; publicationStatus: PublishStatus | null }
  | { ok: false; error: "not_found" };

/**
 * 处理一条举报。
 *
 * - `resolve`（举报成立）：举报关闭，资产下架 → 状态 REJECTED，审核意见写明原因；
 * - `dismiss`（举报不成立）：举报关闭。若该资产已无其他未处理的举报，
 *   且它还在 PENDING（就是因这条举报被下架的），则恢复为 PUBLISHED。
 */
export async function resolveReport(input: {
  reportId: string;
  action: "resolve" | "dismiss";
  note?: string | null;
  reviewerId: string;
}): Promise<ResolveReportResult> {
  const report = await prisma.report.findUnique({
    where: { id: input.reportId },
    include: { asset: { include: { publishedBy: true } } },
  });
  if (!report) {
    return { ok: false, error: "not_found" };
  }

  const note = (input.note ?? "").trim();

  await prisma.report.update({
    where: { id: input.reportId },
    data: {
      status: input.action === "resolve" ? "RESOLVED" : "DISMISSED",
      resolvedAt: new Date(),
    },
  });

  const publication = report.asset?.publishedBy[0] ?? null;
  let publicationStatus: PublishStatus | null = null;

  if (publication) {
    if (input.action === "resolve") {
      const updated = await prisma.userPublishedAsset.update({
        where: { id: publication.id },
        data: {
          status: "REJECTED",
          reviewNote: note.length > 0 ? note : `举报成立：${REPORT_REASON_LABELS[report.reason]}`,
          reviewedAt: new Date(),
          reviewedBy: input.reviewerId,
        },
      });
      publicationStatus = updated.status;
    } else {
      // 举报不成立：看看还有没有别的未处理举报。
      const stillOpen = await prisma.report.count({
        where: { assetId: report.assetId, status: "OPEN" },
      });
      if (stillOpen === 0 && publication.status === "PENDING") {
        const updated = await prisma.userPublishedAsset.update({
          where: { id: publication.id },
          data: {
            status: "PUBLISHED",
            reviewNote: note.length > 0 ? note : "举报不成立，资产已恢复展示。",
            reviewedAt: new Date(),
            reviewedBy: input.reviewerId,
          },
        });
        publicationStatus = updated.status;
      } else {
        publicationStatus = publication.status;
      }
    }
  }

  const row = await prisma.report.findUniqueOrThrow({
    where: { id: input.reportId },
    include: { asset: true },
  });

  return { ok: true, view: toReportView(row), publicationStatus };
}
