"use client";

import { useState } from "react";

/** 举报理由（与 schema 的 `ReportReason` 一致）。 */
const REASONS: readonly { value: string; label: string }[] = [
  { value: "SPAM", label: "垃圾广告" },
  { value: "ILLEGAL", label: "违法违规" },
  { value: "COPYRIGHT", label: "版权问题" },
  { value: "INFRINGING", label: "侵权" },
  { value: "OFFENSIVE", label: "冒犯 / 攻击性内容" },
  { value: "OTHER", label: "其他" },
];

/**
 * 举报入口。
 *
 * 审核链路的第二环（spec 决策 11）：**任何人**都能举报违规内容 ——
 * 游客也行（服务端会把 `reporterUserId` 留空）。
 *
 * 举报**不直接删内容**：只落库，由运营在举报入口决定成立还是驳回。
 */
export function ReportButton({
  target,
  commentId,
  slug,
}: {
  target: "COMMENT" | "ASSET";
  commentId?: string;
  slug?: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("SPAM");
  const [detail, setDetail] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setNotice(null);

    try {
      const response = await fetch("/api/reports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target,
          ...(commentId ? { commentId } : {}),
          ...(slug ? { slug } : {}),
          reason,
          detail,
        }),
      });

      const data = (await response.json()) as { message?: string };

      if (!response.ok) {
        setNotice(typeof data?.message === "string" ? data.message : "举报提交失败，请稍后再试。");
        return;
      }

      setOpen(false);
      setDetail("");
      setNotice("举报已提交，运营会处理。");
    } catch {
      setNotice("网络不太顺，请稍后再试。");
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <span className="report-wrap">
        <button type="button" className="interaction-button" onClick={() => setOpen(true)}>
          举报
        </button>
        {notice ? (
          <span className="ok" role="alert">
            {notice}
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <span className="report-wrap">
      <label className="report-field">
        理由
        <select value={reason} onChange={(event) => setReason(event.target.value)}>
          {REASONS.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.label}
            </option>
          ))}
        </select>
      </label>
      <label className="report-field">
        说明（可选）
        <input
          type="text"
          value={detail}
          maxLength={500}
          placeholder="补充一点上下文"
          onChange={(event) => setDetail(event.target.value)}
        />
      </label>
      <button
        type="button"
        className="interaction-button"
        onClick={() => void submit()}
        disabled={busy}
      >
        {busy ? "提交中…" : "提交举报"}
      </button>
      <button type="button" className="interaction-button" onClick={() => setOpen(false)}>
        取消
      </button>
      {notice ? (
        <span className="bad" role="alert">
          {notice}
        </span>
      ) : null}
    </span>
  );
}
