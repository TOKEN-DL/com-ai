/**
 * 举报的共享路径（票 #10）。
 *
 * 审核链路（spec 决策 11）的第二环：**用户举报**。任何人（登录或游客）
 * 都能举报违规内容；举报落库后出现在运营入口的待处理列表里。
 *
 * ## 状态流转
 *
 * ```
 *   OPEN ──▶ RESOLVED   举报成立 → 被举报内容隐藏
 *   OPEN ──▶ DISMISSED  举报不成立 → 内容保持原样
 * ```
 *
 * `resolvedAt` 记下处理时间。举报本身**不直接删内容** —— 成立时只是把
 * 评论置为 `HIDDEN`（资产的处理属于发布链路 #11，本票不碰）。
 *
 * 游客态举报：`Report.reporterUserId` 允许为空（schema 就是这么设计的），
 * 这样「任何人能举报」成立。登录用户重复举报同一条内容时返回已有那条，
 * 不制造重复行。
 */
import type { ReportReason, ReportStatus, ReportTarget } from "@prisma/client";

import { sanitizeCommentBody } from "@/lib/html";
import { prisma } from "@/lib/prisma";

/** 举报补充说明的长度上限。 */
export const REPORT_DETAIL_MAX_LENGTH = 500;

/** 运营入口里的一条举报。 */
export type ReportView = {
  id: string;
  target: ReportTarget;
  reason: ReportReason;
  detail: string | null;
  status: ReportStatus;
  createdAt: string;
  resolvedAt: string | null;
  /// 举报人（游客态举报时为 null）。
  reporterEmail: string | null;
  /// 被举报的评论（target = COMMENT 时有值）。
  comment: {
    id: string;
    body: string;
    authorName: string;
    assetSlug: string;
    assetDisplayName: string;
  } | null;
  /// 被举报的资产（target = ASSET 时有值）。
  asset: { id: string; slug: string; displayName: string } | null;
};

export type CreateReportOutcome =
  | { ok: true; report: ReportView; duplicate: boolean }
  | { ok: false; status: 400 | 404; error: string; message: string };

/** 合法的举报理由。 */
const REPORT_REASONS: readonly ReportReason[] = [
  "SPAM",
  "ILLEGAL",
  "COPYRIGHT",
  "INFRINGING",
  "OFFENSIVE",
  "OTHER",
];

/** 举报理由是不是受支持的。 */
export function isReportReason(value: unknown): value is ReportReason {
  return typeof value === "string" && (REPORT_REASONS as readonly string[]).includes(value);
}

/** 数据库行 → 运营视图。 */
function toReportView(row: {
  id: string;
  target: ReportTarget;
  reason: ReportReason;
  detail: string | null;
  status: ReportStatus;
  createdAt: Date;
  resolvedAt: Date | null;
  reporter: { email: string } | null;
  comment: {
    id: string;
    body: string;
    status: string;
    user: { displayName: string | null; email: string };
    asset: { slug: string; displayName: string };
  } | null;
  asset: { id: string; slug: string; displayName: string } | null;
}): ReportView {
  return {
    id: row.id,
    target: row.target,
    reason: row.reason,
    detail: row.detail,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    reporterEmail: row.reporter?.email ?? null,
    comment: row.comment
      ? {
          id: row.comment.id,
          body: sanitizeCommentBody(row.comment.body),
          authorName: row.comment.user.displayName?.trim() || row.comment.user.email,
          assetSlug: row.comment.asset.slug,
          assetDisplayName: row.comment.asset.displayName,
        }
      : null,
    asset: row.asset
      ? { id: row.asset.id, slug: row.asset.slug, displayName: row.asset.displayName }
      : null,
  };
}

const REPORT_INCLUDE = {
  reporter: { select: { email: true } },
  comment: {
    include: {
      user: { select: { displayName: true, email: true } },
      asset: { select: { slug: true, displayName: true } },
    },
  },
  asset: { select: { id: true, slug: true, displayName: true } },
} as const;

/**
 * 提交一条举报。
 *
 * 目标二选一：`COMMENT` 走 `commentId`，`ASSET` 走 `assetId`。
 */
export async function createReport(input: {
  target: ReportTarget;
  commentId?: string | null;
  assetId?: string | null;
  reason: ReportReason;
  detail?: string | null;
  reporterUserId?: string | null;
}): Promise<CreateReportOutcome> {
  const detail = input.detail?.trim() ?? "";

  if (detail.length > REPORT_DETAIL_MAX_LENGTH) {
    return {
      ok: false,
      status: 400,
      error: "detail_too_long",
      message: `举报说明不能超过 ${REPORT_DETAIL_MAX_LENGTH} 字。`,
    };
  }

  if (input.target === "COMMENT") {
    if (!input.commentId) {
      return {
        ok: false,
        status: 400,
        error: "missing_comment",
        message: "缺少要举报的评论。",
      };
    }

    const comment = await prisma.comment.findUnique({
      where: { id: input.commentId },
      select: { id: true },
    });

    if (!comment) {
      return {
        ok: false,
        status: 404,
        error: "comment_not_found",
        message: "要举报的评论不存在。",
      };
    }

    // 登录用户重复举报同一条评论 → 返回已有那条，不制造重复行。
    if (input.reporterUserId) {
      const existing = await prisma.report.findFirst({
        where: {
          target: "COMMENT",
          commentId: input.commentId,
          reporterUserId: input.reporterUserId,
          status: "OPEN",
        },
        include: REPORT_INCLUDE,
      });

      if (existing) {
        return { ok: true, report: toReportView(existing), duplicate: true };
      }
    }

    const created = await prisma.report.create({
      data: {
        target: "COMMENT",
        commentId: input.commentId,
        reporterUserId: input.reporterUserId ?? null,
        reason: input.reason,
        detail: detail.length > 0 ? detail : null,
      },
      include: REPORT_INCLUDE,
    });

    return { ok: true, report: toReportView(created), duplicate: false };
  }

  if (!input.assetId) {
    return {
      ok: false,
      status: 400,
      error: "missing_asset",
      message: "缺少要举报的资产。",
    };
  }

  const asset = await prisma.asset.findUnique({ where: { id: input.assetId }, select: { id: true } });

  if (!asset) {
    return {
      ok: false,
      status: 404,
      error: "asset_not_found",
      message: "要举报的资产不存在。",
    };
  }

  if (input.reporterUserId) {
    const existing = await prisma.report.findFirst({
      where: {
        target: "ASSET",
        assetId: input.assetId,
        reporterUserId: input.reporterUserId,
        status: "OPEN",
      },
      include: REPORT_INCLUDE,
    });

    if (existing) {
      return { ok: true, report: toReportView(existing), duplicate: true };
    }
  }

  const created = await prisma.report.create({
    data: {
      target: "ASSET",
      assetId: input.assetId,
      reporterUserId: input.reporterUserId ?? null,
      reason: input.reason,
      detail: detail.length > 0 ? detail : null,
    },
    include: REPORT_INCLUDE,
  });

  return { ok: true, report: toReportView(created), duplicate: false };
}

/** 运营入口：举报列表（默认只看待处理）。 */
export async function listReports(options: {
  status?: ReportStatus;
  limit?: number;
} = {}): Promise<ReportView[]> {
  const { status, limit = 50 } = options;

  const rows = await prisma.report.findMany({
    where: status ? { status } : {},
    include: REPORT_INCLUDE,
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 200),
  });

  return rows.map(toReportView);
}

/**
 * 处理一条举报。
 *
 * `RESOLVED`（举报成立）→ 被举报的评论置为 `HIDDEN`；
 * `DISMISSED`（举报不成立）→ 内容保持原样。
 */
export async function resolveReport(
  reportId: string,
  status: Extract<ReportStatus, "RESOLVED" | "DISMISSED">,
): Promise<{ ok: boolean; message: string }> {
  const report = await prisma.report.findUnique({
    where: { id: reportId },
    select: { id: true, target: true, commentId: true },
  });

  if (!report) {
    return { ok: false, message: "举报不存在。" };
  }

  await prisma.report.update({
    where: { id: reportId },
    data: { status, resolvedAt: new Date() },
  });

  if (status === "RESOLVED" && report.target === "COMMENT" && report.commentId) {
    await prisma.comment.update({
      where: { id: report.commentId },
      data: { status: "HIDDEN" },
    });
  }

  return {
    ok: true,
    message: status === "RESOLVED" ? "举报已处理，内容已隐藏。" : "举报已驳回，内容保持可见。",
  };
}
