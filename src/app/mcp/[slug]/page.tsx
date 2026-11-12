import Link from "next/link";
import { notFound } from "next/navigation";

import { getMcpDetail } from "@/lib/mcp-detail";

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
 * MCP 详情页（票 #13）。
 *
 * 固定包含（票里点名的五项）：
 *   传输方式（本地 stdio / 远程 HTTP）、暴露的工具及其参数结构、
 *   所需环境变量及是否必填、仓库 star 与最近更新日期、
 *   一键复制可粘贴的 mcpServers 配置片段。
 *
 * ⚠️ MCP 条目一律 METADATA_ONLY（registry 不声明每个 server 的许可证），
 *    所以站内**不复制** server 的 README / 源码原文；页面展示的是
 *    registry 的结构化声明与在线探测到的工具定义。
 */
export default async function McpDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const mcp = await getMcpDetail(slug);

  if (!mcp) {
    notFound();
  }

  const repoLabel =
    mcp.repoOwner && mcp.repoName ? `${mcp.repoOwner}/${mcp.repoName}` : "未声明来源仓库";

  return (
    <main className="skill-detail">
      <p className="breadcrumb">
        <Link href="/mcp">← 全部 MCP</Link>
      </p>

      <h1>{mcp.displayName}</h1>
      <p className="lede">
        <code>{mcp.serverName}</code>
        {mcp.serverVersion !== "—" ? ` · 版本 ${mcp.serverVersion}` : ""}
      </p>

      {mcp.summaryZh ? (
        <section className="summary">
          <h2>中文简介</h2>
          <p>{mcp.summaryZh}</p>
        </section>
      ) : null}

      {mcp.description ? (
        <section className="summary">
          <h2>原始描述</h2>
          <p className="original">{mcp.description}</p>
          <p className="note">描述来自 MCP 官方 registry，原文照录。</p>
        </section>
      ) : null}

      <section className="meta">
        <h2>资产信息</h2>
        <dl>
          <dt>传输方式</dt>
          <dd>{mcp.transportLabel}</dd>

          <dt>许可证</dt>
          <dd>
            {mcp.license ? (
              <span className="license-badge">{mcp.license}</span>
            ) : (
              <span className="badge-muted">未声明许可证</span>
            )}
            <span className="badge-muted">
              {mcp.contentTier === "FULL" ? "可存正文" : "仅元数据"}
            </span>
          </dd>

          <dt>来源仓库</dt>
          <dd>
            {mcp.repoUrl ? (
              <a href={mcp.repoUrl} rel="noreferrer noopener" target="_blank">
                {repoLabel}
              </a>
            ) : (
              repoLabel
            )}
          </dd>

          <dt>热度</dt>
          <dd>
            Star {mcp.stars} · 热度位 {mcp.heatScore}
          </dd>

          <dt>最近更新</dt>
          <dd>
            仓库最近推送 {formatDate(mcp.repoPushedAt)} · 站内更新 {formatDate(mcp.updatedAt)}
            {mcp.publishedAt ? ` · 上游发布 ${formatDate(mcp.publishedAt)}` : ""}
          </dd>

          <dt>互动</dt>
          <dd>
            收藏 {mcp.favoriteCount} · 点赞 {mcp.likeCount}
          </dd>

          <dt>采集源</dt>
          <dd>{mcp.sourceId ?? "—"}</dd>
        </dl>
      </section>

      <section className="meta">
        <h2>工具定义</h2>
        {mcp.tools.length === 0 ? (
          <p className="badge-muted">
            {mcp.toolsAvailable
              ? "这个 server 没有声明任何工具。"
              : "采集时没能取到工具定义（连不上、需要凭据，或只支持旧版 SSE 传输）。"}
          </p>
        ) : (
          <ul className="install-list">
            {mcp.tools.map((tool) => (
              <li key={tool.name}>
                <div className="install-head">
                  <strong>{tool.name}</strong>
                  <span className="badge-muted">{tool.params.length} 个参数</span>
                </div>
                {tool.description ? <p>{tool.description}</p> : null}
                {tool.params.length > 0 ? (
                  <ul className="file-list">
                    {tool.params.map((param) => (
                      <li key={param.name}>
                        <code>{param.name}</code>
                        <span className="badge-muted">{param.type}</span>
                        {param.required ? <span className="badge-muted">必填</span> : null}
                        {param.choices.length > 0 ? (
                          <span className="badge-muted">可选值：{param.choices.join(" / ")}</span>
                        ) : null}
                        {param.defaultValue !== null ? (
                          <span className="badge-muted">默认 {param.defaultValue}</span>
                        ) : null}
                        {param.description ? <span>{param.description}</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="badge-muted">无参数。</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="meta">
        <h2>环境变量</h2>
        {mcp.envVars.length === 0 ? (
          <p className="badge-muted">这个 server 没有声明需要的环境变量。</p>
        ) : (
          <ul className="file-list">
            {mcp.envVars.map((variable) => (
              <li key={`${variable.source ?? ""}#${variable.name}`}>
                <code>{variable.name}</code>
                {variable.required ? (
                  <span className="license-badge">必填</span>
                ) : (
                  <span className="badge-muted">可选</span>
                )}
                {variable.secret ? <span className="badge-muted">密钥</span> : null}
                {variable.defaultValue !== null ? (
                  <span className="badge-muted">默认 {variable.defaultValue}</span>
                ) : null}
                {variable.description ? <span>{variable.description}</span> : null}
              </li>
            ))}
          </ul>
        )}
        {mcp.ports.length > 0 ? (
          <p className="note">声明的端口：{mcp.ports.join("、")}</p>
        ) : null}
      </section>

      <section className="install">
        <h2>一键复制配置片段</h2>
        {Object.keys(mcp.config).length > 0 ? (
          <>
            <div className="source-head">
              <CopyButton value={mcp.configText} label="复制 mcpServers 配置" />
              <span className="badge-muted">整段粘进客户端的配置文件即可</span>
            </div>
            <pre className="command">{mcp.configText}</pre>
            <p className="note">
              占位符（如 &lt;TOKEN_在这里填你的值&gt;）需要你自己替换成真实值；
              片段里不含任何真实凭据。
            </p>
          </>
        ) : (
          <p className="badge-muted">
            这个 server 既没有本地包也没有远程端点，生成不了配置片段。
          </p>
        )}
      </section>
    </main>
  );
}
