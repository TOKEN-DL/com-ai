import Link from "next/link";

import {
  buildSearchParams,
  parseSearchQuery,
  toUrlSearchParams,
} from "@/lib/search-params";
import { getSearchService, type SearchSort } from "@/lib/search-service";
import { PROMPT_MODALITY_LABELS } from "@/lib/prompt-detail";
import type { PromptModality } from "@prisma/client";

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

/** 四种模态（顺序 = 展示顺序）。 */
const MODALITIES: PromptModality[] = ["TEXT", "IMAGE", "VIDEO", "MUSIC"];

/** 在一组值里切换某个值（点已选中的 = 取消选择）。 */
function toggle<T>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

/**
 * Prompt 列表页（票 #15）。
 *
 * ⚠️ 这一页**不查数据库**：检索全部经由 {@link getSearchService}，
 *    只多带一个 `kind = PROMPT` 的过滤条件 —— 所以 Prompt 条目天然并入统一搜索，
 *    换检索实现时这个页面一行都不用改。
 *
 * 筛选维度（模态 / 工具）也是走同一套 `SearchFilters`，
 * 所以在统一搜索页与这一页上筛选的含义完全一致。
 */
export default async function PromptListPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const parsed = parseSearchQuery(toUrlSearchParams(raw));
  // 只看 Prompt：分类是列表页自己的过滤条件，与统一搜索的其它维度正交。
  const result = await getSearchService().search({
    ...parsed,
    filters: { ...parsed.filters, kind: ["PROMPT"] },
    pageSize: parsed.pageSize ?? 50,
  });
  const query = result.query;
  const selectedModalities = query.filters.modality ?? [];
  const selectedTools = query.filters.tool ?? [];

  /** 拼一个筛选链接：改一处条件，回到第一页。 */
  const facetHref = (
    patch: Parameters<typeof buildSearchParams>[1],
  ): string => `/prompts?${buildSearchParams(query, { ...patch, page: 1 })}`;

  return (
    <main>
      <h1>Prompt 库</h1>
      <p className="lede">
        按模态收录的提示词 —— 共 {result.total} 条。
        <Link href="/search">到统一搜索里找 Skill / MCP / Prompt →</Link>
      </p>
      <p className="breadcrumb">
        <Link href="/">← 首页</Link>
      </p>

      <form className="search-form" action="/prompts" method="get">
        <input
          className="search-input"
          type="search"
          name="q"
          defaultValue={query.q}
          placeholder="提示词标题或内容"
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

      <div className="search-layout">
        <aside className="search-filters">
          <section className="facet-group">
            <h2>模态</h2>
            <ul className="facet-list">
              {MODALITIES.map((modality) => {
                const bucket = result.facets.modality.find(
                  (item) => item.value === modality,
                );
                const selected = selectedModalities.includes(modality);
                return (
                  <li key={modality}>
                    <Link
                      href={facetHref({ modality: toggle(selectedModalities, modality) })}
                      className={selected ? "facet-selected" : undefined}
                    >
                      {PROMPT_MODALITY_LABELS[modality]}（{bucket?.count ?? 0}）
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="facet-group">
            <h2>工具 / 模型</h2>
            <ul className="facet-list">
              {result.facets.tool.length === 0 ? (
                <li className="badge-muted">暂无按工具标注的提示词。</li>
              ) : (
                result.facets.tool.map((bucket) => {
                  const tool = bucket.value ?? "";
                  const selected = selectedTools.includes(tool);
                  return (
                    <li key={tool}>
                      <Link
                        href={facetHref({ tool: toggle(selectedTools, tool) })}
                        className={selected ? "facet-selected" : undefined}
                      >
                        {tool}（{bucket.count}）
                      </Link>
                    </li>
                  );
                })
              )}
            </ul>
          </section>
        </aside>

        <section className="search-results">
          <p className="search-count">
            共 {result.total} 条
            {query.q.length > 0 ? `（关键词「${query.q}」）` : ""}，第 {query.page} /
            {Math.max(result.totalPages, 1)} 页。
          </p>

          {result.items.length === 0 ? (
            <p className="badge-muted">没有匹配的条目，换个关键词或筛选条件试试。</p>
          ) : (
            <ul className="asset-list">
              {result.items.map((item) => (
                <li key={item.id}>
                  <Link href={`/prompts/${item.slug}`}>{item.displayName}</Link>
                  <span className="asset-meta">
                    {item.repoOwner && item.repoName
                      ? ` · ${item.repoOwner}/${item.repoName}`
                      : ""}
                    {item.license ? ` · ${item.license}` : " · 未声明许可证"}
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
                <Link href={`/prompts?${buildSearchParams(query, { page: query.page - 1 })}`}>
                  ← 上一页
                </Link>
              ) : (
                <span className="badge-muted">← 上一页</span>
              )}
              <span className="badge-muted">
                第 {query.page} / {result.totalPages} 页
              </span>
              {query.page < result.totalPages ? (
                <Link href={`/prompts?${buildSearchParams(query, { page: query.page + 1 })}`}>
                  下一页 →
                </Link>
              ) : (
                <span className="badge-muted">下一页 →</span>
              )}
            </nav>
          ) : null}
        </section>
      </div>
    </main>
  );
}
