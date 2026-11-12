import type { AssetKind } from "@prisma/client";
import Link from "next/link";

import { buildSearchParams, isAssetKind, isPromptModality, parseSearchQuery, toUrlSearchParams } from "@/lib/search-params";
import { getSearchService, type NormalizedQuery, type SearchSort } from "@/lib/search-service";
import { PROMPT_MODALITY_LABELS } from "@/lib/prompt-detail";

import { SummaryUsage } from "@/app/SummaryUsage";

// 检索要实时读库，不许被静态化。
export const dynamic = "force-dynamic";

/** 分类（资产类型）的展示名。 */
const KIND_LABELS: Record<AssetKind, string> = {
  SKILL: "Skill",
  MCP: "MCP",
  PROMPT: "Prompt",
};

/** 排序维度的展示名。 */
const SORT_LABELS: Record<SearchSort, string> = {
  relevance: "相关度",
  heat: "热度",
  recent: "更新时间",
  name: "名称",
};

const SORT_OPTIONS: SearchSort[] = ["relevance", "heat", "recent", "name"];

/** 在一组值里切换某个值（点已选中的 = 取消选择）。 */
function toggle<T>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

/**
 * 详情页链接。
 *
 * MCP 的详情页在 `/mcp/{slug}`（票 #13 补齐的路由），
 * Prompt 的详情页在 `/prompts/{slug}`（票 #15 补齐的路由），
 * 其它类型暂时仍走 `/skills/{slug}`。
 */
function detailHref(kind: AssetKind, slug: string): string {
  if (kind === "MCP") {
    return `/mcp/${slug}`;
  }
  if (kind === "PROMPT") {
    return `/prompts/${slug}`;
  }
  return `/skills/${slug}`;
}

/** 拼一个筛选链接：改一处条件，回到第一页。 */
function facetHref(
  query: NormalizedQuery,
  patch: Parameters<typeof buildSearchParams>[1],
): string {
  return `/search?${buildSearchParams(query, { ...patch, page: 1 })}`;
}

/**
 * 搜索页（spec 决策 9「前端」：列表页 / 详情页 / 搜索页共用一套页面骨架）。
 *
 * 输入框 + 结果列表 + 筛选 + 排序 + 分页；结果项点进详情页。
 *
 * ⚠️ 这一页**不查数据库**：检索全部经由 {@link getSearchService}，
 *    换检索实现时这个页面一行都不用改。
 */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const result = await getSearchService().search(parseSearchQuery(toUrlSearchParams(raw)));
  const query = result.query;

  return (
    <main className="search-page">
      <h1>搜索</h1>
      <p className="lede">
        按关键词找 Skill / MCP / Prompt —— 全文检索 + 模糊匹配，不依赖中文分词扩展。
      </p>

      <form className="search-form" action="/search" method="get">
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

      <div className="search-layout">
        <aside className="search-filters">
          <section className="facet-group">
            <h2>分类</h2>
            <ul className="facet-list">
              {result.facets.kind.map((bucket) => {
                if (bucket.value === null || !isAssetKind(bucket.value)) {
                  return null;
                }
                const kind = bucket.value;
                const selected = query.filters.kind.includes(kind);
                return (
                  <li key={kind}>
                    <Link
                      href={facetHref(query, { kind: toggle(query.filters.kind, kind) })}
                      className={selected ? "facet-selected" : undefined}
                    >
                      {KIND_LABELS[kind]}（{bucket.count}）
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="facet-group">
            <h2>许可证</h2>
            <ul className="facet-list">
              {result.facets.license.map((bucket) => {
                const license = bucket.value;
                const selected = query.filters.license.includes(license);
                const label = license ?? "未声明许可证";
                return (
                  <li key={label}>
                    <Link
                      href={facetHref(query, { license: toggle(query.filters.license, license) })}
                      className={selected ? "facet-selected" : undefined}
                    >
                      {label}（{bucket.count}）
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="facet-group">
            <h2>官方版本</h2>
            <ul className="facet-list">
              {result.facets.official.map((bucket) => {
                const official = bucket.value === "true";
                const selected = query.filters.official === official;
                return (
                  <li key={bucket.value ?? "unknown"}>
                    <Link
                      href={facetHref(query, { official: selected ? null : official })}
                      className={selected ? "facet-selected" : undefined}
                    >
                      {official ? "有官方版本" : "没有官方版本"}（{bucket.count}）
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>

          {/*
            模态与工具 / 模型（票 #15）。
            只对 PROMPT 有意义 —— 分面本来就是从 PromptDetail 出来的，
            没有 prompt 时这两个分面是空的，所以直接不渲染。
          */}
          {result.facets.modality.length > 0 ? (
            <section className="facet-group">
              <h2>模态</h2>
              <ul className="facet-list">
                {result.facets.modality.map((bucket) => {
                  if (!bucket.value || !isPromptModality(bucket.value)) {
                    return null;
                  }
                  const modality = bucket.value;
                  const selected = (query.filters.modality ?? []).includes(modality);
                  return (
                    <li key={modality}>
                      <Link
                        href={facetHref(query, {
                          modality: toggle(query.filters.modality ?? [], modality),
                        })}
                        className={selected ? "facet-selected" : undefined}
                      >
                        {PROMPT_MODALITY_LABELS[modality]}（{bucket.count}）
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}

          {result.facets.tool.length > 0 ? (
            <section className="facet-group">
              <h2>工具 / 模型</h2>
              <ul className="facet-list">
                {result.facets.tool.map((bucket) => {
                  const tool = bucket.value ?? "";
                  const selected = (query.filters.tool ?? []).includes(tool);
                  return (
                    <li key={tool}>
                      <Link
                        href={facetHref(query, { tool: toggle(query.filters.tool ?? [], tool) })}
                        className={selected ? "facet-selected" : undefined}
                      >
                        {tool}（{bucket.count}）
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
        </aside>

        <section className="search-results">
          <p className="search-count">
            共 {result.total} 条
            {query.q.length > 0 ? `（关键词「${query.q}」）` : ""}，第 {result.page} /
            {Math.max(result.totalPages, 1)} 页。
          </p>

          {result.items.length === 0 ? (
            <p className="badge-muted">没有匹配的条目，换个关键词试试。</p>
          ) : (
            <ul className="asset-list">
              {result.items.map((item) => (
                <li key={item.id}>
                  <Link href={detailHref(item.kind, item.slug)}>{item.displayName}</Link>
                  <span className="asset-meta">
                    {KIND_LABELS[item.kind]}
                    {item.repoOwner && item.repoName
                      ? ` · ${item.repoOwner}/${item.repoName}`
                      : ""}
                    {item.license ? ` · ${item.license}` : " · 未声明许可证"}
                    {item.isOfficial ? " · 官方" : ""}
                    {` · 热度 ${item.heatScore}`}
                  </span>
                  {item.summaryZh ? <p className="asset-summary">{item.summaryZh}</p> : null}
                  {/* 搜索结果项也展示「何时用」与「怎么用」（票 #7 验收标准）。 */}
                  <SummaryUsage whenToUse={item.whenToUse} howToUse={item.howToUse} />
                </li>
              ))}
            </ul>
          )}

          {result.totalPages > 1 ? (
            <nav className="pagination">
              {query.page > 1 ? (
                <Link href={`/search?${buildSearchParams(query, { page: query.page - 1 })}`}>
                  ← 上一页
                </Link>
              ) : (
                <span className="badge-muted">← 上一页</span>
              )}
              <span className="badge-muted">
                第 {query.page} / {result.totalPages} 页
              </span>
              {query.page < result.totalPages ? (
                <Link href={`/search?${buildSearchParams(query, { page: query.page + 1 })}`}>
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
