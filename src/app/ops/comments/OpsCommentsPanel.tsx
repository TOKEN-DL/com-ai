"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type OpsComment = {
  id: string;
  body: string;
  authorName: string;
  authorEmail: string;
  status: string;
  filteredReason: string | null;
  assetSlug: string;
  assetDisplayName: string;
  reportCount: number;
  createdAt: string;
};

/** 可选的时间窗口（天）。 */
const WINDOWS = [7, 30, 90] as const;

/** 状态的可读说法。 */
const STATUS_LABELS: Record<string, string> = {
  VISIBLE: "公开中",
  PENDING: "待抽查（命中过滤）",
  HIDDEN: "已隐藏",
  DELETED: "已删除",
};

/**
 * 抽查面板：从 `/api/ops/comments` 按时间拉近期评论。
 *
 * 权限由服务端判（MODERATOR / ADMIN）；这里只把「进不来」的原因显示出来。
 */
export function OpsCommentsPanel() {
  const [days, setDays] = useState<number>(7);
  const [items, setItems] = useState<OpsComment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async (window: number) => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/ops/comments?days=${window}`, { cache: "no-store" });

      if (response.status === 401) {
        setError("运营入口需要登录。");
        setItems([]);
        return;
      }
      if (response.status === 403) {
        setError("需要运营权限才能进入这个入口。");
        setItems([]);
        return;
      }
      if (!response.ok) {
        setError("加载失败，请稍后再试。");
        return;
      }

      const data = (await response.json()) as { items?: OpsComment[] };
      setItems(Array.isArray(data?.items) ? data.items : []);
    } catch {
      setError("网络不太顺，请稍后再试。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(days);
  }, [days, load]);

  const act = async (commentId: string, action: "approve" | "hide" | "restore") => {
    setNotice(null);

    try {
      const response = await fetch("/api/ops/comments", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commentId, action }),
      });

      const data = (await response.json()) as { message?: string };

      if (!response.ok) {
        setNotice(typeof data?.message === "string" ? data.message : "操作失败，请稍后再试。");
        return;
      }

      setNotice(typeof data?.message === "string" ? data.message : "已更新。");
      await load(days);
    } catch {
      setNotice("网络不太顺，请稍后再试。");
    }
  };

  return (
    <div className="ops-panel">
      <div className="interaction-row">
        <span className="badge-muted">时间窗口</span>
        {WINDOWS.map((window) => (
          <button
            key={window}
            type="button"
            className="interaction-button"
            aria-pressed={days === window}
            onClick={() => setDays(window)}
          >
            最近 {window} 天
          </button>
        ))}
        <button type="button" className="interaction-button" onClick={() => void load(days)}>
          刷新
        </button>
      </div>

      {error ? (
        <p className="bad" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="ok" role="alert">
          {notice}
        </p>
      ) : null}

      {loading ? <p className="badge-muted">加载中…</p> : null}

      {!loading && !error && items.length === 0 ? (
        <p className="badge-muted">这个时间窗口里没有评论。</p>
      ) : null}

      <ul className="comment-list">
        {items.map((item) => (
          <li key={item.id} className="comment-item">
            <div className="comment-head">
              <span className="comment-author">{item.authorName}</span>
              <span className="badge-muted">{item.authorEmail}</span>
              <time className="comment-time" dateTime={item.createdAt}>
                {new Date(item.createdAt).toLocaleString("zh-CN")}
              </time>
            </div>

            <p className="comment-body" dangerouslySetInnerHTML={{ __html: item.body }} />

            <div className="comment-head">
              <Link href={`/skills/${item.assetSlug}`}>{item.assetDisplayName}</Link>
              <span className="badge-muted">{STATUS_LABELS[item.status] ?? item.status}</span>
              {item.filteredReason ? (
                <span className="badge-muted">命中：{item.filteredReason}</span>
              ) : null}
              {item.reportCount > 0 ? (
                <span className="badge-muted">举报 {item.reportCount} 次</span>
              ) : null}
            </div>

            <div className="comment-actions">
              {item.status === "PENDING" ? (
                <button
                  type="button"
                  className="interaction-button"
                  onClick={() => void act(item.id, "approve")}
                >
                  放行
                </button>
              ) : null}
              {item.status !== "HIDDEN" ? (
                <button
                  type="button"
                  className="interaction-button"
                  onClick={() => void act(item.id, "hide")}
                >
                  隐藏
                </button>
              ) : (
                <button
                  type="button"
                  className="interaction-button"
                  onClick={() => void act(item.id, "restore")}
                >
                  恢复显示
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
