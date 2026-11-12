import Link from "next/link";
import { notFound } from "next/navigation";

import { listAssetComments } from "@/lib/comments";
import { getScenarioDetail } from "@/lib/scenario-detail";

import { CommentsSection } from "@/app/skills/[slug]/CommentsSection";

// 详情要实时读库，不许被静态化。
export const dynamic = "force-dynamic";

/**
 * 场景卡片详情页（票 #12）。
 *
 * 固定包含三块：
 *   1. **场景描述** —— 这张卡片讲的是「什么时候用」；
 *   2. **直达 Skill** —— 点一下跳到源资产的详情页；
 *   3. **评论区** —— 与资产详情页**共用同一套评论数据**：
 *      读的是源资产的评论，发出去的评论也落在源资产上
 *      （`Comment.assetId` 指源资产，不是卡片自己）。
 *
 * ## 为什么评论挂在源资产上，而不是卡片自己
 *
 * 验收标准写的是「卡片下方可评论，且**与资产详情页共用同一套评论数据**」。
 * 另起一套评论数据 = 社区被切成两半：同一个 Skill 的经验散在两处。
 * 所以评论只存一份，挂在 Skill 上；卡片只是这个评论区的一个「场景入口」。
 */
export default async function ScenarioDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const card = await getScenarioDetail(slug);

  if (!card) {
    notFound();
  }

  // 评论是源资产的评论 —— 与 Skill 详情页是同一批数据。
  const comments = card.source ? await listAssetComments(card.source.assetId) : [];

  const repoLabel =
    card.source?.repoOwner && card.source.repoName
      ? `${card.source.repoOwner}/${card.source.repoName}`
      : "未知来源";

  return (
    <main className="skill-detail">
      <p className="breadcrumb">
        <Link href="/scenarios">← 全部场景卡片</Link>
      </p>

      <h1>{card.displayName}</h1>
      <p className="lede">
        场景卡片 · 派生自{card.originLabel}
        {card.source ? ` · 热度 ${card.source.heatScore}` : ""}
      </p>

      {card.summaryZh ? (
        <section className="summary">
          <h2>场景描述</h2>
          <p>{card.summaryZh}</p>
          <p className="note">
            这张卡片由站上已收录 Skill 的使用场景自动派生，场景短语本身也参与站内检索。
          </p>
        </section>
      ) : null}

      <section className="meta">
        <h2>直达 Skill</h2>
        {card.source ? (
          <dl>
            <dt>对应 Skill</dt>
            <dd>
              <Link href={`/skills/${card.source.slug}`}>{card.source.displayName}</Link>
            </dd>

            <dt>来源仓库</dt>
            <dd>
              {card.source.repoUrl ? (
                <a href={card.source.repoUrl} rel="noreferrer noopener" target="_blank">
                  {repoLabel}
                </a>
              ) : (
                repoLabel
              )}
            </dd>

            <dt>许可证</dt>
            <dd>
              {card.source.license ? (
                <span className="license-badge">{card.source.license}</span>
              ) : (
                <span className="badge-muted">未声明</span>
              )}
            </dd>

            <dt>热度</dt>
            <dd>
              Star {card.source.stars} · 安装 {card.source.installs} · 热度位{" "}
              {card.source.heatScore}
            </dd>
          </dl>
        ) : (
          <p className="badge-muted">这个场景对应的 Skill 已经不在站上了。</p>
        )}
      </section>

      {/* 评论与 Skill 详情页是同一套数据：读的是源资产的评论，
          发表也落在源资产上（slug 传的是源资产的 slug）。 */}
      {card.source ? (
        <CommentsSection slug={card.source.slug} comments={comments} />
      ) : (
        <section className="comments">
          <p className="badge-muted">源 Skill 已不在站上，评论区暂不可用。</p>
        </section>
      )}
    </main>
  );
}
