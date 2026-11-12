import Link from "next/link";

import { listAssets } from "@/lib/asset-query";

import { SummaryUsage } from "@/app/SummaryUsage";

// 列表要实时读库，不许被静态化。
export const dynamic = "force-dynamic";

/**
 * Skill 列表页。
 *
 * 关键词检索是 #5 的 `SearchService` 的事，这里先按热度 / 时间倒序展示。
 */
export default async function SkillListPage() {
  const assets = await listAssets({ kind: "SKILL", limit: 50 });

  return (
    <main>
      <h1>Skill</h1>
<p className="lede">
        面向中文 AI 开发者的 Agent Skill —— 收录 {assets.length} 个。
        <Link href="/search">按关键词搜索 →</Link>
      </p>
      <p className="breadcrumb">
        <Link href="/favorites">我的收藏</Link>
      </p>

      {assets.length === 0 ? (
        <p className="badge-muted">还没有收录任何 Skill。</p>
      ) : (
        <ul className="asset-list">
          {assets.map((asset) => (
            <li key={asset.id}>
              <Link href={`/skills/${asset.slug}`}>{asset.displayName}</Link>
              <span className="asset-meta">
                {asset.repoOwner && asset.repoName ? `${asset.repoOwner}/${asset.repoName}` : "—"}
                {asset.license ? ` · ${asset.license}` : ""}
                {` · 热度 ${asset.heatScore}`}
                {` · 收藏 ${asset.favoriteCount}`}
                {` · 点赞 ${asset.likeCount}`}
              </span>
              {asset.summaryZh ? <p className="asset-summary">{asset.summaryZh}</p> : null}
              {/* 「何时用」与「怎么用」分区显示（票 #7）。 */}
              <SummaryUsage whenToUse={asset.whenToUse} howToUse={asset.howToUse} />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
