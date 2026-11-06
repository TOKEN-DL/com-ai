"use client";

import { useState } from "react";

import type { CommentView } from "@/lib/comments";

import { CommentComposer } from "./CommentComposer";
import { ReportButton } from "./ReportButton";

/**
 * 评论列表（客户端组件）。
 *
 * 为什么列表本身是客户端组件：发完评论要能**立刻**看到新评论，
 * 不必整页刷新。初始数据由服务端组件 `CommentsSection` 读好传进来，
 * 客户端只负责追加新发表的评论与回复。
 */
export function CommentList({
  slug,
  initialComments,
}: {
  slug: string;
  initialComments: CommentView[];
}) {
  const [comments, setComments] = useState<CommentView[]>(initialComments);

  const addTopLevel = (comment: CommentView) => {
    setComments((previous) => [...previous, comment]);
  };

  const addReply = (parentId: string, reply: CommentView) => {
    setComments((previous) =>
      previous.map((comment) =>
        comment.id === parentId ? { ...comment, replies: [...comment.replies, reply] } : comment,
      ),
    );
  };

  const total = comments.reduce((sum, comment) => sum + 1 + comment.replies.length, 0);

  return (
    <>
      <h2>评论（{total}）</h2>

      <CommentComposer slug={slug} onPosted={addTopLevel} />

      {comments.length === 0 ? <p className="badge-muted">还没有评论，来说两句。</p> : null}

      <ul className="comment-list">
        {comments.map((comment) => (
          <CommentItem key={comment.id} comment={comment} slug={slug} onReply={addReply} />
        ))}
      </ul>
    </>
  );
}

/** 一条评论 + 它的回复列表。 */
function CommentItem({
  comment,
  slug,
  onReply,
}: {
  comment: CommentView;
  slug: string;
  onReply: (parentId: string, reply: CommentView) => void;
}) {
  const [replying, setReplying] = useState(false);

  return (
    <li className="comment-item">
      <div className="comment-head">
        <span className="comment-author">{comment.authorName}</span>
        <time className="comment-time" dateTime={comment.createdAt}>
          {comment.createdAt.slice(0, 16).replace("T", " ")}
        </time>
      </div>

      {/* 正文已在服务端做过 HTML 消毒（escapeHtml），这里当纯文本渲染。 */}
      <p className="comment-body" dangerouslySetInnerHTML={{ __html: comment.body }} />

      <div className="comment-actions">
        <button
          type="button"
          className="interaction-button"
          onClick={() => setReplying((value) => !value)}
          aria-expanded={replying}
        >
          {replying ? "收起回复" : "回复"}
        </button>
        <ReportButton target="COMMENT" commentId={comment.id} />
      </div>

      {replying ? (
        <CommentComposer
          slug={slug}
          parentId={comment.id}
          placeholder="回复这条评论…"
          onPosted={(reply) => {
            onReply(comment.id, reply);
            setReplying(false);
          }}
          onCancel={() => setReplying(false)}
        />
      ) : null}

      {comment.replies.length > 0 ? (
        <ul className="reply-list">
          {comment.replies.map((reply) => (
            <li key={reply.id} className="comment-item reply-item">
              <div className="comment-head">
                <span className="comment-author">{reply.authorName}</span>
                <time className="comment-time" dateTime={reply.createdAt}>
                  {reply.createdAt.slice(0, 16).replace("T", " ")}
                </time>
              </div>
              <p className="comment-body" dangerouslySetInnerHTML={{ __html: reply.body }} />
              <div className="comment-actions">
                <ReportButton target="COMMENT" commentId={reply.id} />
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
