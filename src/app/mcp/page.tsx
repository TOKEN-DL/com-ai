import Link from "next/link";

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
 * MCP 列表页（票 #13）。
 *
 * ⚠️ 这一页**不查数据库**：检索全部经由 {@link getSearchService}，
 *    只多带一个 `kind = MCP` 的过滤条件 —— 所以 MCP 条目天然并入统一搜索，
 *    换检索实现时这个页面一行都不用改。
 */
export default async function McpListPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const parsed = parseSearchQuery(toUrlSearchParams(raw));
  // 只看 MCP：分类是列表页自己的过滤条件，与统一搜索的其它维度正交。
  const result = await getSearchService().search({
    ...parsed,
    filters: { ...parsed.filters, kind: ["MCP"] },
    pageSize: parsed.pageSize ?? 50,
  });
  const query = result.query;

  return (
    <main>
      <h1>MCP</h1>
      <p className="lede">
        收录自 MCP 官方 registry 的 MCP server —— 共 {result.total} 个。
        <Link href="/search">到统一搜索里找 Skill / Prompt →</Link>
      </p>
      <p className="breadcrumb">
        <Link href="/">← 首页</Link>
      </p>

      <form className="search-form" action="/mcp" method="get">
        <input
          className="search-input"
          type="search"
          name="q"
          defaultValue={query.q}
          placeholder="filesystem"
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
        <p className="badge-muted">没有匹配的条目，换个关键词试试。</p>
      ) : (
        <ul className="asset-list">
          {result.items.map((item) => (
            <li key={item.id}>
              <Link href={`/mcp/${item.slug}`}>{item.displayName}</Link>
              <span className="asset-meta">
                {item.repoOwner && item.repoName ? ` · ${item.repoOwner}/${item.repoName}` : ""}
                {item.stars > 0 ? ` · Star ${item.stars}` : ""}
                {` · 热度 ${item.heatScore}`}
              </span>
              {item.summaryZh ? <p className="asset-summary">{item.summaryZh}</p> : null}
            </li>
          ))}
        </ul>
      )}

      {result.totalPages > 1 ? (
        <nav className="pagination">
          {query.page > 1 ? (
            <Link href={`/mcp?${buildSearchParams(query, { page: query.page - 1 })}`}>
              ← 上一页
            </Link>
          ) : (
            <span className="badge-muted">← 上一页</span>
          )}
          <span className="badge-muted">
            第 {query.page} / {result.totalPages} 页
          </span>
          {query.page < result.totalPages ? (
            <Link href={`/mcp?${buildSearchParams(query, { page: query.page + 1 })}`}>
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
