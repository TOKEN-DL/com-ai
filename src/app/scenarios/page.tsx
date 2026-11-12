import Link from "next/link";

import { listScenarioSources } from "@/lib/scenario-service";
import { buildSearchParams, parseSearchQuery, toUrlSearchParams } from "@/lib/search-params";
import { getSearchService, type SearchSort } from "@/lib/search-service";

// 列表要实时读库，不许被静态化。
export const dynamic = "force-dynamic";

/** 排序维度的展示名。 */
const SORT_LABELS: Record<SearchSort, string> = {
  relevance: "相关度",
  heat: "热度",
  recent: "更新时间",
  name: "名称",
};

const SORT_OPTIONS: SearchSort[] = ["relevance", "heat", "recent", "name"];

/**
 * 场景卡片列表页（票 #12）。
 *
 * ## 这是社区的冷启动入口
 *
 * 资讯模块后置、社区还没有现成内容可发，所以社区先以「卡片评论区」的形式跑起来：
 * 每张卡片下面挂的就是**对应 Skill 的评论区**（与资产详情页同一套评论数据），
 * 用户可以在那里补充参数与经验。
 *
 * ## 检索一律经由 SearchService
 *
 * ⚠️ 这一页**不查数据库**：场景卡片是 `kind = SCENARIO` 的资产行，
 *    所以它天然并入统一检索（票 #5），换检索实现时这个页面一行都不用改。
 *    （页面里那次 `listScenarioSources` 只是给当前页的卡片补上「指向哪个 Skill」，
 *    不参与检索。）
 */
export default async function ScenarioListPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const parsed = parseSearchQuery(toUrlSearchParams(raw));
  // 只看场景卡片：分类是列表页自己的过滤条件，与统一搜索的其它维度正交。
  const result = await getSearchService().search({
    ...parsed,
    filters: { ...parsed.filters, kind: ["SCENARIO"] },
    pageSize: parsed.pageSize ?? 50,
  });
  const query = result.query;

  // 当前页的卡片 → 源资产（用于「直达 Skill」）。
  const sources = await listScenarioSources(result.items.map((item) => item.id));

  return (
    <main>
      <h1>场景卡片</h1>
      <p className="lede">
        「想做 X 就用这个」—— 从已收录 Skill 的使用场景自动派生，共 {result.total} 张。
        <Link href="/search">到统一搜索里找 Skill / MCP / Prompt →</Link>
      </p>
      <p className="breadcrumb">
        <Link href="/">← 首页</Link>
      </p>

      <form className="search-form" action="/scenarios" method="get">
        <input
          className="search-input"
          type="search"
          name="q"
          defaultValue={query.q}
          placeholder="批量处理 PDF"
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
        <p className="badge-muted">没有匹配的场景卡片，换个关键词试试。</p>
      ) : (
        <ul className="asset-list">
          {result.items.map((item) => {
            const source = sources.get(item.id);
            return (
              <li key={item.id}>
                <Link href={`/scenarios/${item.slug}`}>{item.displayName}</Link>
                {source ? (
                  <span className="asset-meta">
                    {" · 对应 Skill "}
                    <Link href={`/skills/${source.slug}`}>{source.displayName}</Link>
                    {source.repoOwner && source.repoName
                      ? ` · ${source.repoOwner}/${source.repoName}`
                      : ""}
                  </span>
                ) : null}
                <span className="asset-meta">{` · 热度 ${item.heatScore}`}</span>
                {item.summaryZh ? <p className="asset-summary">{item.summaryZh}</p> : null}
              </li>
            );
          })}
        </ul>
      )}

      {result.totalPages > 1 ? (
        <nav className="pagination">
          {query.page > 1 ? (
            <Link href={`/scenarios?${buildSearchParams(query, { page: query.page - 1 })}`}>
              ← 上一页
            </Link>
          ) : (
            <span className="badge-muted">← 上一页</span>
          )}
          <span className="badge-muted">
            第 {query.page} / {result.totalPages} 页
          </span>
          {query.page < result.totalPages ? (
            <Link href={`/scenarios?${buildSearchParams(query, { page: query.page + 1 })}`}>
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
