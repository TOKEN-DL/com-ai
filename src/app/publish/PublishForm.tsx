"use client";

import type { AssetKind } from "@prisma/client";
import Link from "next/link";
import { useState } from "react";

import { assetDetailHref } from "@/lib/asset-item";

/** 发布接口的回应（字段与 `POST /api/publish` 一致）。 */
type PublishResult = {
  ok?: boolean;
  slug?: string;
  status?: string;
  contentTier?: string;
  summaryZh?: string | null;
  summarySource?: string | null;
  whenToUse?: string | null;
  howToUse?: string | null;
  aiGenerated?: boolean;
  /// 落库的依赖关系（票 #17）。
  dependencies?: {
    slug: string;
    displayName: string;
    kind: AssetKind;
    constraint: string | null;
  }[];
  message?: string;
  error?: string;
};

const KIND_OPTIONS = [
  { value: "SKILL", label: "Skill（SKILL.md）" },
  { value: "MCP", label: "MCP Server" },
  { value: "PROMPT", label: "Prompt（提示词）" },
];

/** 常见的 SPDX 许可证 id（可自由输入别的）。 */
const LICENSE_SUGGESTIONS = [
  "mit",
  "apache-2.0",
  "cc0-1.0",
  "cc-by-4.0",
  "bsd-3-clause",
  "isc",
  "unlicense",
  "gpl-3.0",
  "agpl-3.0",
];

/**
 * 发布表单。
 *
 * 字段就是票里说的那几项：资产类型、名称、仓库地址、许可证、简介；
 * 另加一个可选的「正文」—— 正文只有在你声明的许可证**允许再分发**时才会被保存，
 * 否则站内只留元数据与链接（这是 spec 的硬性约束，不是可选项）。
 */
export function PublishForm() {
  const [kind, setKind] = useState("SKILL");
  const [displayName, setDisplayName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [license, setLicense] = useState("");
  const [description, setDescription] = useState("");
  const [contentBody, setContentBody] = useState("");
  const [version, setVersion] = useState("");
  const [manifestPath, setManifestPath] = useState("");
  const [manifest, setManifest] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<PublishResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch("/api/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind,
          displayName,
          repoUrl,
          license: license.trim() || null,
          description,
          contentBody: contentBody.trim() || null,
          version: version.trim() || null,
          manifestPath: manifestPath.trim() || null,
          manifest: manifest.trim() || null,
        }),
      });

      const body = (await response.json()) as PublishResult;

      if (!response.ok) {
        setError(body.message ?? "发布失败，请稍后再试。");
        return;
      }

      setResult(body);
    } catch {
      setError("网络不太顺，请稍后再试。");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="publish-form">
      <form className="publish-fields" onSubmit={submit}>
        <label htmlFor="publish-kind">资产类型</label>
        <select
          id="publish-kind"
          name="kind"
          value={kind}
          onChange={(event) => setKind(event.target.value)}
        >
          {KIND_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <label htmlFor="publish-name">名称</label>
        <input
          id="publish-name"
          name="displayName"
          type="text"
          required
          maxLength={120}
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder="我的 PDF 批处理 Skill"
        />

        <label htmlFor="publish-repo">仓库地址</label>
        <input
          id="publish-repo"
          name="repoUrl"
          type="text"
          required
          value={repoUrl}
          onChange={(event) => setRepoUrl(event.target.value)}
          placeholder="https://github.com/owner/repo"
        />

        <label htmlFor="publish-license">许可证</label>
        <input
          id="publish-license"
          name="license"
          type="text"
          list="publish-license-options"
          value={license}
          onChange={(event) => setLicense(event.target.value)}
          placeholder="留空 = 未声明（站内只保留元数据与链接）"
        />
        <datalist id="publish-license-options">
          {LICENSE_SUGGESTIONS.map((item) => (
            <option key={item} value={item} />
          ))}
        </datalist>

        <label htmlFor="publish-description">简介</label>
        <textarea
          id="publish-description"
          name="description"
          required
          rows={3}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="一句话说清楚：这个资产是干什么的、什么时候用。"
        />

        <label htmlFor="publish-content">正文（可选）</label>
        <textarea
          id="publish-content"
          name="contentBody"
          rows={8}
          value={contentBody}
          onChange={(event) => setContentBody(event.target.value)}
          placeholder="SKILL.md / MCP 配置 / 提示词原文。只有声明了允许再分发的许可证才会被保存。"
        />
        <p className="badge-muted">
          声明了允许再分发的许可（MIT / Apache-2.0 / CC0 等）才会保存正文并据此生成中文简介；
          其余情况站内只保留元数据与链接。
        </p>

        <details className="publish-advanced">
          <summary>进阶（版本号、依赖声明）</summary>

          <label htmlFor="publish-version">版本号</label>
          <input
            id="publish-version"
            name="version"
            type="text"
            value={version}
            onChange={(event) => setVersion(event.target.value)}
            placeholder="1.0.0"
          />

          <label htmlFor="publish-manifest">依赖清单路径</label>
          <input
            id="publish-manifest"
            name="manifestPath"
            type="text"
            value={manifestPath}
            onChange={(event) => setManifestPath(event.target.value)}
            placeholder="com-ai.manifest.yaml"
          />
          <p className="badge-muted">
            清单在仓库里的相对路径（写清楚别人去哪找它）。
          </p>

          <label htmlFor="publish-manifest-content">依赖清单内容</label>
          <textarea
            id="publish-manifest-content"
            name="manifest"
            rows={8}
            value={manifest}
            onChange={(event) => setManifest(event.target.value)}
            placeholder={
              "dependencies:\n  - slug: pdf-batch-processor\n    kind: SKILL\n    version: \">=1.2.0\""
            }
          />
          <p className="badge-muted">
            平台约定的清单格式（YAML，JSON 也行）：顶层写 dependencies 列表，
            每条依赖用被依赖资产在平台上的 slug 标识；version 只展示、不做版本求解。
            格式非法会直接报错（带行号），不会悄悄忽略。
          </p>
        </details>

        <button type="submit" className="interaction-button" disabled={submitting}>
          {submitting ? "发布中…" : "发布"}
        </button>
      </form>

      {error ? (
        <p className="bad" role="alert">
          {error}
        </p>
      ) : null}

      {result ? (
        <div className="publish-result">
          <p className="ok">{result.message ?? "发布成功。"}</p>

          <dl className="meta">
            <dt>状态</dt>
            <dd>{result.status === "PENDING" ? "审核中" : "已发布"}</dd>

            <dt>内容档位</dt>
            <dd>{result.contentTier === "FULL" ? "可存正文（FULL）" : "仅元数据（METADATA_ONLY）"}</dd>

            <dt>简介来源</dt>
            <dd>
              {result.aiGenerated
                ? "AI 生成（初稿）—— 版权归原作者"
                : result.summarySource === "TEMPLATE"
                  ? "模板生成（AI 生成失败时的降级）"
                  : "你写的"}
            </dd>

            {result.summaryZh ? (
              <>
                <dt>中文简介</dt>
                <dd>{result.summaryZh}</dd>
              </>
            ) : null}

            {result.whenToUse ? (
              <>
                <dt>何时用</dt>
                <dd>{result.whenToUse}</dd>
              </>
            ) : null}

            {result.howToUse ? (
              <>
                <dt>怎么用</dt>
                <dd>{result.howToUse}</dd>
              </>
            ) : null}

            {result.dependencies && result.dependencies.length > 0 ? (
              <>
                <dt>依赖</dt>
                <dd>
                  <ul className="file-list">
                    {result.dependencies.map((dependency) => (
                      <li key={dependency.slug}>
                        <Link href={assetDetailHref(dependency.kind, dependency.slug)}>
                          {dependency.displayName}
                        </Link>
                        <span className="badge-muted">{dependency.kind}</span>
                        {dependency.constraint ? (
                          <span className="badge-muted">{dependency.constraint}</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </dd>
              </>
            ) : null}
          </dl>

          <p>
            <Link href="/publish/mine">看看我的发布状态 →</Link>
          </p>
        </div>
      ) : null}
    </section>
  );
}
