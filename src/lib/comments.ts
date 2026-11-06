/**
 * 评论与回复的共享路径（票 #10）。
 *
 * 责任归属：评论**必须登录**（spec 决策 10）——点赞的数字要好看，评论要能
 * 追责，所以评论挂在 `User` 上（`Comment.userId`），游客态没有评论这条路。
 *
 * 审核链路（spec 决策 11）：**默认直接公开**。不做全量预审队列 ——
 * 单人运营下那会立刻成为瓶颈。正常评论落库即公开（`CommentStatus.VISIBLE`）；
 * 只有命中自动关键词过滤的才被拦下，落成 `PENDING` 留给运营抽查。
 *
 * ## 两级讨论串
 *
 * 顶层评论（`parentId = null`）+ 挂在它下面的回复（`parentId = 顶层评论`）。
 * **回复不能再挂回复** —— 讨论串就是两级，页面上是「评论列表 + 回复列表」。
 *
 * ## 消毒
 *
 * 落库的 `Comment.body` 是**原文**（运营要看到用户到底写了什么）；
 * 读路径统一经过 `sanitizeCommentBody`，所以页面与 API 拿到的都是
 * 消毒后的正文，直接当 HTML 渲染也安全。
 */
import type { CommentStatus, ReportReason } from "@prisma/client";

import { findBlockedKeywords } from "@/lib/content-filter";
import { sanitizeCommentBody } from "@/lib/html";
import { prisma } from "@/lib/prisma";

/** 评论正文上限（字符）。 */
export const COMMENT_BODY_MAX_LENGTH = 2000;

/** 公开视图里的一条评论。 */
export type CommentView = {
  id: string;
  /// 已消毒的正文（可以直接当 HTML 渲染）。
  body: string;
  /// 展示名：优先用显示名，没有就用打码后的邮箱。
  authorName: string;
  createdAt: string;
  /// 回复列表（两级讨论串的第二级）。
  replies: CommentView[];
};

/** 运营抽查视图：比公开视图多出审核相关的字段。 */
export type OpsCommentView = {
  id: string;
  body: string;
  authorName: string;
  authorEmail: string;
  status: CommentStatus;
  /// 命中自动关键词过滤时的原因（词表里的原词）。
  filteredReason: string | null;
  assetSlug: string;
  assetDisplayName: string;
  /// 该评论收到的举报数。
  reportCount: number;
  createdAt: string;
};

/** 打码邮箱：保留首字符与域名，避免把完整邮箱暴露在评论页上。 */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) {
    return "匿名用户";
  }
  const local = email.slice(0, at);
  const domain = email.slice(at);
  return `${local.slice(0, 1)}***${domain}`;
}

/** 作者展示名：显示名优先，其次打码邮箱。 */
function authorNameOf(displayName: string | null, email: string): string {
  const trimmed = displayName?.trim();
  return trimmed ? trimmed : maskEmail(email);
}

/** 数据库行 → 公开视图。 */
function toCommentView(row: {
  id: string;
  body: string;
  createdAt: Date;
  user: { displayName: string | null; email: string };
}): CommentView {
  return {
    id: row.id,
    body: sanitizeCommentBody(row.body),
    authorName: authorNameOf(row.user.displayName, row.user.email),
    createdAt: row.createdAt.toISOString(),
    replies: [],
  };
}

/**
 * 某个资产下的评论树（只含公开评论）。
 *
 * 只有 `VISIBLE` 的评论对外可见：`PENDING`（命中过滤，待抽查）、
 * `HIDDEN`（被举报隐藏）、`DELETED` 都不出现。
 * 父评论被隐藏时，它的回复也跟着不出现 —— 讨论串是整体。
 */
export async function listAssetComments(assetId: string): Promise<CommentView[]> {
  const rows = await prisma.comment.findMany({
    where: { assetId },
    include: { user: { select: { displayName: true, email: true } } },
    orderBy: { createdAt: "asc" },
  });

  const byId = new Map<string, { view: CommentView; status: CommentStatus; parentId: string | null }>();
  const tops: CommentView[] = [];

  for (const row of rows) {
    byId.set(row.id, { view: toCommentView(row), status: row.status, parentId: row.parentId });
  }

  for (const row of rows) {
    if (row.status !== "VISIBLE") {
      continue;
    }

    const entry = byId.get(row.id);
    if (!entry) {
      continue;
    }

    if (row.parentId) {
      const parent = byId.get(row.parentId);
      // 父评论不可见（被隐藏 / 待抽查）→ 整条讨论串都不公开。
      // 父评论本身是回复 → 超过两级，不展示。
      if (!parent || parent.status !== "VISIBLE" || parent.parentId !== null) {
        continue;
      }
      parent.view.replies.push(entry.view);
      continue;
    }

    tops.push(entry.view);
  }

  return tops;
}

/** 发表评论的结果。 */
export type CreateCommentOutcome =
  | {
      ok: true;
      comment: CommentView;
      /// `VISIBLE` = 已公开；`PENDING` = 命中过滤词，待运营抽查。
      status: CommentStatus;
      /// 命中的过滤词（只给运营看，不发给用户）。
      matchedKeywords: string[];
    }
  | {
      ok: false;
      status: 400 | 404;
      error: string;
      message: string;
    };

/**
 * 发表一条评论（顶层）或一条回复。
 *
 * 命中自动关键词过滤时**不公开**：落库成 `PENDING`，把命中的词记进
 * `filteredReason`，由运营在抽查入口决定放行还是隐藏。
 */
export async function createComment(input: {
  assetId: string;
  userId: string;
  body: string;
  parentId?: string | null;
}): Promise<CreateCommentOutcome> {
  const body = input.body.trim();

  if (body.length === 0) {
    return { ok: false, status: 400, error: "empty_body", message: "评论内容不能为空。" };
  }

  if (body.length > COMMENT_BODY_MAX_LENGTH) {
    return {
      ok: false,
      status: 400,
      error: "body_too_long",
      message: `评论内容不能超过 ${COMMENT_BODY_MAX_LENGTH} 字。`,
    };
  }

  let parentId: string | null = null;

  if (input.parentId) {
    const parent = await prisma.comment.findUnique({
      where: { id: input.parentId },
      select: { id: true, assetId: true, parentId: true },
    });

    if (!parent) {
      return { ok: false, status: 404, error: "parent_not_found", message: "要回复的评论不存在。" };
    }

    if (parent.assetId !== input.assetId) {
      return {
        ok: false,
        status: 400,
        error: "parent_mismatch",
        message: "要回复的评论不在这个资产下。",
      };
    }

    if (parent.parentId !== null) {
      return {
        ok: false,
        status: 400,
        error: "reply_too_deep",
        message: "只能回复顶层评论，讨论串是两级。",
      };
    }

    parentId = parent.id;
  }

  const matchedKeywords = findBlockedKeywords(body);
  const filtered = matchedKeywords.length > 0;

  const created = await prisma.comment.create({
    data: {
      assetId: input.assetId,
      userId: input.userId,
      parentId,
      body,
      status: filtered ? "PENDING" : "VISIBLE",
      filteredReason: filtered ? matchedKeywords.join("、") : null,
    },
    include: { user: { select: { displayName: true, email: true } } },
  });

  return {
    ok: true,
    comment: toCommentView(created),
    status: created.status,
    matchedKeywords,
  };
}

/** 运营抽查：按时间浏览近期评论。 */
export type RecentCommentsOptions = {
  /// 回看多少天。默认 7 天。
  days?: number;
  /// 最多返回多少条。默认 50。
  limit?: number;
  /// 只看某个状态；不传 = 全部状态。
  status?: CommentStatus;
};

/**
 * 近期评论（默认最近 7 天，按时间倒序）。
 *
 * 抽查是「运营不定期巡查」，不是全量预审队列 —— 所以这里只是**按时间排序
 * 拉一段出来给人看**，默认只给最近几天。
 */
export async function listRecentComments(
  options: RecentCommentsOptions = {},
): Promise<OpsCommentView[]> {
  const { days = 7, limit = 50, status } = options;

  const since = new Date(Date.now() - Math.max(0, days) * 24 * 60 * 60 * 1000);

  const rows = await prisma.comment.findMany({
    where: {
      createdAt: { gte: since },
      ...(status ? { status } : {}),
    },
    include: {
      user: { select: { displayName: true, email: true } },
      asset: { select: { slug: true, displayName: true } },
      _count: { select: { reports: true } },
    },
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(limit, 1), 200),
  });

  return rows.map((row) => ({
    id: row.id,
    body: sanitizeCommentBody(row.body),
    authorName: authorNameOf(row.user.displayName, row.user.email),
    authorEmail: row.user.email,
    status: row.status,
    filteredReason: row.filteredReason,
    assetSlug: row.asset.slug,
    assetDisplayName: row.asset.displayName,
    reportCount: row._count.reports,
    createdAt: row.createdAt.toISOString(),
  }));
}

/** 改一条评论的审核状态（运营在抽查入口用）。 */
export async function setCommentStatus(
  commentId: string,
  status: CommentStatus,
): Promise<{ ok: boolean; message: string }> {
  const existing = await prisma.comment.findUnique({ where: { id: commentId } });
  if (!existing) {
    return { ok: false, message: "评论不存在。" };
  }

  await prisma.comment.update({ where: { id: commentId }, data: { status } });
  return { ok: true, message: "已更新评论状态。" };
}

/** 举报理由的可读说法（运营抽查页用）。 */
export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  SPAM: "垃圾广告",
  ILLEGAL: "违法违规",
  COPYRIGHT: "版权问题",
  INFRINGING: "侵权",
  OFFENSIVE: "冒犯/攻击性内容",
  OTHER: "其他",
};

/** 评论状态的可读说法（运营抽查页用）。 */
export const COMMENT_STATUS_LABELS: Record<CommentStatus, string> = {
  VISIBLE: "公开中",
  PENDING: "待抽查（命中过滤）",
  HIDDEN: "已隐藏",
  DELETED: "已删除",
};
