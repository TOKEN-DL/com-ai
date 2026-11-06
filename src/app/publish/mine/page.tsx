import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { listMyPublications } from "@/lib/publish-moderation";
import { resolveSessionUser, SESSION_COOKIE } from "@/lib/session";

// 要实时读库，不许被静态化。
export const dynamic = "force-dynamic";

/**
 * 「我的发布」列表（票 #11）。
 *
 * 每条都带**审核状态**与**审核意见** —— 发布者有权知道自己的东西
 * 现在是什么状态、为什么被下架。
 */
export default async function MyPublishPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  const user = await resolveSessionUser(token);

  if (!user) {
    redirect("/login");
  }

  const items = await listMyPublications(user.id);

  return (
    <main>
      <h1>我的发布</h1>
      <p className="lede">
        你发布过的资产与它们的审核状态。<Link href="/publish">再发一个 →</Link>
      </p>

      {items.length === 0 ? (
        <p className="badge-muted">还没有发布过任何东西。</p>
      ) : (
        <ul className="asset-list">
          {items.map((item) => (
            <li key={item.id}>
              <div className="asset-meta">
                <strong>{item.displayName}</strong>
                <span className="badge-muted">{item.kind}</span>
                <span className="badge-muted">{item.statusLabel}</span>
                {item.license ? (
                  <span className="license-badge">{item.license}</span>
                ) : (
                  <span className="badge-muted">未声明</span>
                )}
                <span className="badge-muted">
                  {item.contentTier === "FULL" ? "可存正文" : "仅元数据"}
                </span>
              </div>

              <p className="asset-summary">
                {item.summaryZh ?? "（暂无简介）"}
                {item.summarySource === "LLM" ? (
                  <span className="note">AI 生成，版权归原作者</span>
                ) : null}
              </p>

              {item.whenToUse ? (
                <p className="badge-muted">何时用：{item.whenToUse}</p>
              ) : null}
              {item.howToUse ? <p className="badge-muted">怎么用：{item.howToUse}</p> : null}

              <p className="badge-muted">
                {item.statusHint}发布于 {new Date(item.publishedAt).toLocaleString("zh-CN")}
                {item.repoUrl ? (
                  <>
                    {" · "}
                    <a href={item.repoUrl} rel="noreferrer noopener" target="_blank">
                      原仓库
                    </a>
                  </>
                ) : null}
                {item.kind === "SKILL" ? (
                  <>
                    {" · "}
                    <Link href={`/skills/${item.slug}`}>看详情</Link>
                  </>
                ) : null}
              </p>

              {item.filteredReason ? (
                <p className="badge-muted">自动过滤原因：{item.filteredReason}</p>
              ) : null}

              {item.reviewNote ? (
                <p className="note">审核意见：{item.reviewNote}</p>
              ) : null}

              {item.reportedCount > 0 ? (
                <p className="badge-muted">被举报 {item.reportedCount} 次</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
