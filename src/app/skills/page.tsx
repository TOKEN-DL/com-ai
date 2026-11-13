import Link from "next/link";

import { buildSearchParams, parseSearchQuery, toUrlSearchParams } from "@/lib/search-params";
import { getSearchService } from "@/lib/search-service";
import { resolvePageSort, SORT_LABELS, sortOptionsForKinds } from "@/lib/sort-options";
import { formatTrend, TREND_LABEL } from "@/lib/trend";

import { SummaryUsage } from "@/app/SummaryUsage";

// 列表要实时读库，不许被静态化。
export const dynamic = "force-dynamic";

/**
 * 排序选项（票 #24）。
 *
 * Skill 有安装量口径（累计安装量 + 近期增速），所以六个选项都给。
 */
const SORT_OPTIONS = sortOptionsForKinds(["SKILL"]);

/**
 * Skill 列表页（票 #24）。
 *
 * ⚠️ 这一页**不查数据库**：检索全部经由 {@link getSearchService}，
 *    只多带一个 `kind = SKILL` 的过滤条件 —— 与 `/mcp`、`/prompts`、
 *    `/scenarios` 是同一套页面骨架（spec 决策 9「前端」）。
 *
 * 改走检索层之前，这一页是 `listAssets({ kind: "SKILL", limit: 50 })`：
 * 没有筛选、没有排序、没有分页，页头的「收录 N 个」显示的其实是当前页的 50 条。
 */
export default async function SkillListPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const parsed = parseSearchQuery(toUrlSearchParams(raw));
  // 只看 Skill：分类是列表页自己的过滤条件，与统一搜索的其它维度正交。
  const result = await getSearchService().search({
    ...parsed,
    sort: resolvePageSort(parsed.sort, SORT_OPTIONS, parsed.q),
    filters: { ...parsed.filters, kind: ["SKILL"] },
    pageSize: parsed.pageSize ?? 50,
  });
  const query = result.query;

  return (
    <main>
      <h1>Skill</h1>
      <p className="lede">
        面向中文 AI 开发者的 Agent Skill —— 共 {result.total} 个。
        <Link href="/search">按关键词搜索 →</Link>
      </p>
      <p className="breadcrumb">
        <Link href="/favorites">我的收藏</Link>
      </p>

      <form className="search-form" action="/skills" method="get">
        <input
          className="search-input"
          type="search"
          name="q"
          defaultValue={query.q}
          placeholder="技能名称或仓库"
          aria-label="关键词"
        />
        <select className="search-sort" name="sort" defaultValue={query.sort} aria-label="排序">
          {SORT_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {SORT_LABELS[option]}
            </option>
          ))}
        </select>
        <button className="copy-button" type="submit">
          搜索
        </button>
      </form>

      {result.items.length === 0 ? (
        <p className="badge-muted">
          {query.q.length > 0 ? "没有匹配的条目，换个关键词试试。" : "还没有收录任何 Skill。"}
        </p>
      ) : (
        <ul className="asset-list">
          {result.items.map((item) => (
            <li key={item.id}>
              <Link href={`/skills/${item.slug}`}>{item.displayName}</Link>
              <span className="asset-meta">
                {item.repoOwner && item.repoName ? `${item.repoOwner}/${item.repoName}` : "—"}
                {item.license ? ` · ${item.license}` : ""}
                {` · 热度 ${item.heatScore}`}
                {item.installs > 0 ? ` · 安装 ${item.installs}` : ""}
                {` · 收藏 ${item.favoriteCount}`}
                {` · 点赞 ${item.likeCount}`}
                {/* 按增速排序时把增速显示出来 —— 否则列表顺序看着像随机的。 */}
                {query.sort === "trending" ? ` · ${TREND_LABEL} ${formatTrend(item.trendScore)}` : ""}
              </span>
              {item.summaryZh ? <p className="asset-summary">{item.summaryZh}</p> : null}
              {/* 「何时用」与「怎么用」分区显示（票 #7）。 */}
              <SummaryUsage whenToUse={item.whenToUse} howToUse={item.howToUse} />
            </li>
          ))}
        </ul>
      )}

      {result.totalPages > 1 ? (
        <nav className="pagination">
          {query.page > 1 ? (
            <Link href={`/skills?${buildSearchParams(query, { page: query.page - 1 })}`}>
              ← 上一页
            </Link>
          ) : (
            <span className="badge-muted">← 上一页</span>
          )}
          <span className="badge-muted">
            第 {query.page} / {result.totalPages} 页
          </span>
          {query.page < result.totalPages ? (
            <Link href={`/skills?${buildSearchParams(query, { page: query.page + 1 })}`}>
              下一页 →
            </Link>
          ) : (
            <span className="badge-muted">下一页 →</span>
          )}
        </nav>
      ) : null}
    </main>
  );
}
