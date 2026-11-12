"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

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
 * 取近期评论。
 *
 * 刻意**不碰组件状态**：取数与改状态分开，组件里所有 setState 都发生在
 * `await` 之后（效果里直接 setState 会造成级联渲染）。
 */
async function fetchComments(window: number): Promise<{ items: OpsComment[]; error: string | null }> {
  let response: Response;

  try {
    response = await fetch(`/api/ops/comments?days=${window}`, { cache: "no-store" });
  } catch {
    return { items: [], error: "网络不太顺，请稍后再试。" };
  }

  if (response.status === 401) {
    return { items: [], error: "运营入口需要登录。" };
  }
  if (response.status === 403) {
    return { items: [], error: "需要运营权限才能进入这个入口。" };
  }
  if (!response.ok) {
    return { items: [], error: "加载失败，请稍后再试。" };
  }

  try {
    const data = (await response.json()) as { items?: OpsComment[] };
    return { items: Array.isArray(data?.items) ? data.items : [], error: null };
  } catch {
    return { items: [], error: "加载失败，请稍后再试。" };
  }
}

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

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const result = await fetchComments(days);
      if (cancelled) {
        return;
      }
      setItems(result.items);
      setError(result.error);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [days]);

  const refresh = (window: number) => {
    setLoading(true);
    setNotice(null);

    void (async () => {
      const result = await fetchComments(window);
      setItems(result.items);
      setError(result.error);
      setLoading(false);
    })();
  };

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

      const result = await fetchComments(days);
      setItems(result.items);
      setError(result.error);
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
            onClick={() => {
              setDays(window);
              setLoading(true);
            }}
          >
            最近 {window} 天
          </button>
        ))}
        <button type="button" className="interaction-button" onClick={() => refresh(days)}>
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
