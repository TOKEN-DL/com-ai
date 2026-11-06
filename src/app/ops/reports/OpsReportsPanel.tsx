"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type OpsReport = {
  id: string;
  target: string;
  reason: string;
  detail: string | null;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
  reporterEmail: string | null;
  comment: {
    id: string;
    body: string;
    authorName: string;
    assetSlug: string;
    assetDisplayName: string;
  } | null;
  asset: { id: string; slug: string; displayName: string } | null;
};

/** 举报理由的可读说法。 */
const REASON_LABELS: Record<string, string> = {
  SPAM: "垃圾广告",
  ILLEGAL: "违法违规",
  COPYRIGHT: "版权问题",
  INFRINGING: "侵权",
  OFFENSIVE: "冒犯 / 攻击性内容",
  OTHER: "其他",
};

/**
 * 取待处理举报。
 *
 * 刻意**不碰组件状态**：取数与改状态分开，组件里所有 setState 都发生在
 * `await` 之后（效果里直接 setState 会造成级联渲染）。
 */
async function fetchReports(): Promise<{ items: OpsReport[]; error: string | null }> {
  let response: Response;

  try {
    response = await fetch("/api/ops/reports", { cache: "no-store" });
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
    const data = (await response.json()) as { items?: OpsReport[] };
    return { items: Array.isArray(data?.items) ? data.items : [], error: null };
  } catch {
    return { items: [], error: "加载失败，请稍后再试。" };
  }
}

/**
 * 举报处理面板：从 `/api/ops/reports` 看待处理举报。
 *
 * 权限由服务端判（MODERATOR / ADMIN）；这里只把「进不来」的原因显示出来。
 */
export function OpsReportsPanel() {
  const [items, setItems] = useState<OpsReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const result = await fetchReports();
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
  }, []);

  const refresh = () => {
    setLoading(true);
    setNotice(null);

    void (async () => {
      const result = await fetchReports();
      setItems(result.items);
      setError(result.error);
      setLoading(false);
    })();
  };

  const act = async (reportId: string, action: "resolve" | "dismiss") => {
    setNotice(null);

    try {
      const response = await fetch("/api/ops/reports", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reportId, action }),
      });

      const data = (await response.json()) as { message?: string };

      if (!response.ok) {
        setNotice(typeof data?.message === "string" ? data.message : "操作失败，请稍后再试。");
        return;
      }

      setNotice(typeof data?.message === "string" ? data.message : "已处理。");

      const result = await fetchReports();
      setItems(result.items);
      setError(result.error);
    } catch {
      setNotice("网络不太顺，请稍后再试。");
    }
  };

  return (
    <div className="ops-panel">
      <div className="interaction-row">
        <button type="button" className="interaction-button" onClick={() => refresh()}>
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
        <p className="badge-muted">当前没有待处理的举报。</p>
      ) : null}

      <ul className="comment-list">
        {items.map((item) => (
          <li key={item.id} className="comment-item">
            <div className="comment-head">
              <span className="comment-author">{REASON_LABELS[item.reason] ?? item.reason}</span>
              <time className="comment-time" dateTime={item.createdAt}>
                {new Date(item.createdAt).toLocaleString("zh-CN")}
              </time>
              <span className="badge-muted">举报人：{item.reporterEmail ?? "游客"}</span>
            </div>

            {item.comment ? (
              <>
                <p className="comment-body" dangerouslySetInnerHTML={{ __html: item.comment.body }} />
                <div className="comment-head">
                  <Link href={`/skills/${item.comment.assetSlug}`}>
                    {item.comment.assetDisplayName}
                  </Link>
                  <span className="badge-muted">作者：{item.comment.authorName}</span>
                </div>
              </>
            ) : null}

            {item.asset ? (
              <div className="comment-head">
                <Link href={`/skills/${item.asset.slug}`}>{item.asset.displayName}</Link>
                <span className="badge-muted">被举报的资产</span>
              </div>
            ) : null}

            {item.detail ? <p className="badge-muted">举报说明：{item.detail}</p> : null}

            <div className="comment-actions">
              <button
                type="button"
                className="interaction-button"
                onClick={() => void act(item.id, "resolve")}
              >
                举报成立（隐藏内容）
              </button>
              <button
                type="button"
                className="interaction-button"
                onClick={() => void act(item.id, "dismiss")}
              >
                举报不成立（驳回）
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
