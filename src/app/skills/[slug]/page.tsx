import Link from "next/link";
import { notFound } from "next/navigation";

import { getSkillDetail } from "@/lib/asset-detail";

import { CopyButton } from "./CopyButton";

// 详情要实时读库，不许被静态化。
export const dynamic = "force-dynamic";

/**
 * Skill 详情页。
 *
 * 固定包含（spec 决策 9「前端」）：
 *   中文简介 / 原始描述 / 许可证标识 / 来源仓库链接 / 热度位 / 一键复制。
 *
 * 一键复制覆盖：安装命令（按宿主）、整份 SKILL.md。
 * 复制的文本由服务端直接传进按钮组件，与页面显示的是同一个字符串。
 */
export default async function SkillDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const skill = await getSkillDetail(slug);

  if (!skill) {
    notFound();
  }

  const repoLabel =
    skill.repoOwner && skill.repoName ? `${skill.repoOwner}/${skill.repoName}` : "未知来源";

  return (
    <main className="skill-detail">
      <p className="breadcrumb">
        <Link href="/skills">← 全部 Skill</Link>
      </p>

      <h1>{skill.displayName}</h1>

      {skill.summaryZh ? (
        <section className="summary">
          <h2>中文简介</h2>
          <p>{skill.summaryZh}</p>
          {skill.summarySource === "LLM" ? (
            <p className="note">AI 生成，版权归原作者</p>
          ) : null}
        </section>
      ) : null}

      {skill.description ? (
        <section className="summary">
          <h2>原始描述</h2>
          <p className="original">{skill.description}</p>
        </section>
      ) : null}

      <section className="meta">
        <h2>资产信息</h2>
        <dl>
          <dt>许可证</dt>
          <dd>
            {skill.license ? (
              <span className="license-badge">{skill.license}</span>
            ) : (
              <span className="badge-muted">未声明</span>
            )}
            <span className="badge-muted">
              {skill.contentTier === "FULL" ? "可存正文" : "仅元数据"}
            </span>
          </dd>

          <dt>来源仓库</dt>
          <dd>
            {skill.repoUrl ? (
              <a href={skill.repoUrl} rel="noreferrer noopener" target="_blank">
                {repoLabel}
              </a>
            ) : (
              repoLabel
            )}
          </dd>

          {skill.upstreamUrl ? (
            <>
              <dt>原始 SKILL.md</dt>
              <dd>
                <a href={skill.upstreamUrl} rel="noreferrer noopener" target="_blank">
                  在 GitHub 上查看
                </a>
              </dd>
            </>
          ) : null}

          {skill.skillPath ? (
            <>
              <dt>仓库内路径</dt>
              <dd>
                <code>{skill.skillPath}</code>
              </dd>
            </>
          ) : null}

          <dt>热度位</dt>
          <dd>
            {skill.heatScore} 分 · 安装 {skill.installs} · Star {skill.stars}
          </dd>

          <dt>采集源</dt>
          <dd>{skill.sourceId ?? "—"}</dd>
        </dl>
      </section>

      <section className="install">
        <h2>一键安装</h2>
        {skill.installCmds.length > 0 ? (
          <ul className="install-list">
            {skill.installCmds.map((entry) => (
              <li key={entry.host}>
                <div className="install-head">
                  <strong>{entry.label}</strong>
                  {entry.path ? <code className="muted-code">{entry.path}</code> : null}
                </div>
                <pre className="command">{entry.command}</pre>
                <CopyButton value={entry.command} label={`复制 ${entry.label} 安装命令`} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="badge-muted">暂无可用的安装命令。</p>
        )}
      </section>

      {skill.extraFiles.length > 0 ? (
        <section className="meta">
          <h2>附属文件</h2>
          <ul className="file-list">
            {skill.extraFiles.map((file) => (
              <li key={file.path}>
                <code>{file.path}</code>
                {file.size === null ? null : <span className="badge-muted">{file.size} B</span>}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="source">
        <h2>SKILL.md 原文</h2>
        {skill.contentAvailable && skill.contentBody !== null ? (
          <>
            <div className="source-head">
              <CopyButton value={skill.contentBody} label="复制整份 SKILL.md" />
              <span className="badge-muted">与上游逐字一致</span>
            </div>
            <pre className="skill-source">{skill.contentBody}</pre>
          </>
        ) : (
          <p className="badge-muted">
            该上游没有声明允许再分发的许可证，站内不复制正文全文。
            {skill.upstreamUrl ? (
              <>
                {" "}
                <a href={skill.upstreamUrl} rel="noreferrer noopener" target="_blank">
                  前往原仓库查看
                </a>
              </>
            ) : null}
          </p>
        )}
      </section>
    </main>
  );
}
