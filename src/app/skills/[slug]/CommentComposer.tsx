"use client";

import { useEffect, useState } from "react";

import type { CommentView } from "@/lib/comments";

type CommentComposerProps = {
  slug: string;
  /// 有值就是回复（挂在这条评论下）；不传就是顶层评论。
  parentId?: string;
  placeholder?: string;
  /// 发表成功后把新评论交给上层（上层负责把它插进列表）。
  onPosted: (comment: CommentView) => void;
  onCancel?: () => void;
};

/**
 * 发表评论 / 回复的输入框。
 *
 * 评论**必须登录**（spec 决策 10：责任归属）。所以：
 *   - 游客态直接看到「登录后即可评论」的引导，而不是一个点了才失败的输入框；
 *   - 万一会话在渲染之后过期，提交会拿到 401，这时把服务端的提示原样显示出来。
 *
 * 命中自动关键词过滤时服务端回 422 + 明确提示，这里原样显示 —— 被拦下不能是静默的。
 */
export function CommentComposer({
  slug,
  parentId,
  placeholder = "说点什么…",
  onPosted,
  onCancel,
}: CommentComposerProps) {
  // null = 还没问出来；true / false = 问出来了。
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [body, setBody] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch("/api/auth/me", { cache: "no-store" });
        if (!response.ok) {
          return;
        }
        const data = (await response.json()) as { authenticated?: boolean };
        if (!cancelled) {
          setAuthed(Boolean(data?.authenticated));
        }
      } catch {
        // 问不到登录态就先按游客处理，提交时服务端还会再判一次。
        if (!cancelled) {
          setAuthed(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async () => {
    setBusy(true);
    setNotice(null);
    setLoginUrl(null);

    try {
      const response = await fetch(`/api/assets/${encodeURIComponent(slug)}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parentId ? { body, parentId } : { body }),
      });

      const data = (await response.json()) as {
        comment?: CommentView;
        message?: string;
        loginUrl?: string;
      };

      if (!response.ok) {
        setNotice(typeof data?.message === "string" ? data.message : "发表失败，请稍后再试。");
        if (response.status === 401) {
          setLoginUrl(typeof data?.loginUrl === "string" ? data.loginUrl : "/login");
        }
        return;
      }

      if (data?.comment) {
        onPosted(data.comment);
      }
      setBody("");
      setNotice("已发表。");
    } catch {
      setNotice("网络不太顺，请稍后再试。");
    } finally {
      setBusy(false);
    }
  };

  if (authed === false) {
    return (
      <div className="comment-composer">
        <p className="badge-muted">
          评论需要登录（要能追责）。
          {loginUrl ? (
            <>
              {" "}
              <a href={loginUrl}>去登录</a>
            </>
          ) : (
            <>
              {" "}
              <a href="/login">去登录</a>
            </>
          )}
        </p>
      </div>
    );
  }

  return (
    <div className="comment-composer">
      <textarea
        className="comment-input"
        value={body}
        placeholder={placeholder}
        rows={parentId ? 2 : 3}
        maxLength={2000}
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="comment-actions">
        <button
          type="button"
          className="interaction-button"
          onClick={() => void submit()}
          disabled={busy || body.trim().length === 0}
        >
          {busy ? "发表中…" : parentId ? "回复" : "发表评论"}
        </button>
        {onCancel ? (
          <button type="button" className="interaction-button" onClick={onCancel}>
            取消
          </button>
        ) : null}
      </div>
      {notice ? (
        <p className={notice === "已发表。" ? "ok" : "bad"} role="alert">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
