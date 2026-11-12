import Link from "next/link";
import { notFound } from "next/navigation";

import { getPromptDetail } from "@/lib/prompt-detail";

import { CopyButton } from "@/app/CopyButton";

// 详情要实时读库，不许被静态化。
export const dynamic = "force-dynamic";

/** 日期的展示形态（站内统一用「年-月-日」）。 */
function formatDate(value: Date | null): string {
  if (!value) {
    return "—";
  }
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Prompt 详情页（票 #15）。
 *
 * 固定包含（票里点名的那几项）：
 *   模态分类、工具 / 模型标注、提示词原文（一键复制）、
 *   **原始来源链接**与**许可证标识**、以及署名类许可（CC BY 4.0）的署名要求。
 *
 * ⚠️ 一键复制拿到的 `copyText` 就是 `promptBody` 本身 ——
 *    页面显示的文本与复制的文本是**同一个字符串**，所以「复制出来与来源逐字一致」
 *    是构造上保证的，不靠两边对齐。
 */
export default async function PromptDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const prompt = await getPromptDetail(slug);

  if (!prompt) {
    notFound();
  }

  const repoLabel =
    prompt.repoOwner && prompt.repoName
      ? `${prompt.repoOwner}/${prompt.repoName}`
      : "未声明来源仓库";

  return (
    <main className="skill-detail">
      <p className="breadcrumb">
        <Link href="/prompts">← 全部 Prompt</Link>
      </p>

      <h1>{prompt.displayName}</h1>
      <p className="lede">
        模态：{prompt.modalityLabel}
        {prompt.toolTags.length > 0 ? ` · 工具 / 模型：${prompt.toolTags.join("、")}` : ""}
      </p>

      {prompt.summaryZh ? (
        <section className="summary">
          <h2>中文简介</h2>
          <p>{prompt.summaryZh}</p>
        </section>
      ) : null}

      <section className="meta">
        <h2>资产信息</h2>
        <dl>
          <dt>模态</dt>
          <dd>{prompt.modalityLabel}</dd>

          <dt>工具 / 模型</dt>
          <dd>
            {prompt.toolTags.length > 0 ? prompt.toolTags.join("、") : "通用提示词"}
          </dd>

          <dt>动作</dt>
          <dd>{prompt.act ?? "—"}</dd>

          <dt>许可证</dt>
          <dd>
            {prompt.license ? (
              <span className="license-badge">{prompt.license}</span>
            ) : (
              <span className="badge-muted">未声明许可证</span>
            )}
            <span className="badge-muted">
              {prompt.contentTier === "FULL" ? "可存正文" : "仅元数据"}
            </span>
          </dd>

          <dt>原始来源</dt>
          <dd>
            {prompt.repoUrl ? (
              <a href={prompt.repoUrl} rel="noreferrer noopener" target="_blank">
                {repoLabel}
              </a>
            ) : (
              repoLabel
            )}
            {prompt.upstreamUrl ? (
              <>
                {" · "}
                <a href={prompt.upstreamUrl} rel="noreferrer noopener" target="_blank">
                  查看原文
                </a>
              </>
            ) : null}
          </dd>

          {prompt.contributor ? (
            <>
              <dt>贡献者</dt>
              <dd>{prompt.contributor}</dd>
            </>
          ) : null}

          {prompt.attribution ? (
            <>
              <dt>署名</dt>
              <dd className="attribution">{prompt.attribution}</dd>
            </>
          ) : null}

          <dt>热度</dt>
          <dd>
            Star {prompt.stars} · 热度位 {prompt.heatScore}
          </dd>

          <dt>最近更新</dt>
          <dd>
            站内更新 {formatDate(prompt.updatedAt)}
            {prompt.lastSyncedAt ? ` · 最近采集 ${formatDate(prompt.lastSyncedAt)}` : ""}
            {prompt.publishedAt ? ` · 上游发布 ${formatDate(prompt.publishedAt)}` : ""}
          </dd>

          <dt>互动</dt>
          <dd>
            收藏 {prompt.favoriteCount} · 点赞 {prompt.likeCount}
          </dd>

          <dt>采集源</dt>
          <dd>{prompt.sourceId ?? "—"}</dd>
        </dl>
      </section>

      {prompt.forDevs ? (
        <section className="summary">
          <h2>面向开发者</h2>
          <p>{prompt.forDevs}</p>
        </section>
      ) : null}

      <section className="install">
        <h2>提示词原文</h2>
        {prompt.promptBody !== null ? (
          <>
            <div className="source-head">
              <CopyButton value={prompt.copyText} label="复制提示词原文" />
              <span className="badge-muted">复制出来的内容与来源逐字一致</span>
            </div>
            {/* ⚠️ 正文用 <pre> 原样输出：不做 trim、不做转义以外的任何加工。 */}
            <pre className="command">{prompt.promptBody}</pre>
          </>
        ) : (
          <p className="badge-muted">
            该上游未声明允许再分发的许可证，站内只保留元数据与链接，
            正文请前往
            {prompt.upstreamUrl ? (
              <a href={prompt.upstreamUrl} rel="noreferrer noopener" target="_blank">
                {" "}
                原仓库
              </a>
            ) : (
              " 原仓库"
            )}
            查看。
          </p>
        )}
      </section>
    </main>
  );
}
