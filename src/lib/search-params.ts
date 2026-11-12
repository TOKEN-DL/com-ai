/**
 * URL 查询参数 ↔ {@link SearchQuery} 的翻译层。
 *
 * 页面（`/search`）与接口（`/api/search`）共用同一套解析与拼装，
 * 保证「页面上的筛选条」与「接口的查询参数」含义完全一致 ——
 * 两边各写一遍再对齐，早晚会对不上。
 *
 * 这里只做**语法层**的翻译（字符串 ↔ 契约里的类型）；
 * 语义层的归一化（去重、夹紧分页、默认排序）由检索实现负责。
 */
import { AssetKind } from "@prisma/client";

import {
  UNDECLARED_LICENSE,
  type NormalizedQuery,
  type SearchQuery,
  type SearchSort,
} from "@/lib/search-service";

/** 允许的排序维度。 */
const SORTS: readonly SearchSort[] = ["relevance", "heat", "recent", "name"];

/** 默认每页条数（拼 URL 时不重复写出来）。 */
const DEFAULT_PAGE_SIZE = 20;

/**
 * 解析查询参数。
 *
 * 认这些参数：
 *   q         关键词（单值）
 *   kind      分类（可重复）
 *   license   许可证（可重复；`__none__` = 未声明许可证）
 *   official  是否有官方版本（`true` / `false`）
 *   sort      排序维度（单值）
 *   page      页码（从 1 开始）
 *   pageSize  每页条数
 */
export function parseSearchQuery(params: URLSearchParams): SearchQuery {
  const kind: AssetKind[] = [];
  for (const raw of params.getAll("kind")) {
    const value = raw.trim().toUpperCase();
    if (!isAssetKind(value) || kind.includes(value)) {
      continue;
    }
    kind.push(value);
  }

  const license: (string | null)[] = [];
  for (const raw of params.getAll("license")) {
    const value = raw.trim();
    if (value === UNDECLARED_LICENSE) {
      if (!license.includes(null)) {
        license.push(null);
      }
      continue;
    }
    const normalized = value.toLowerCase();
    if (normalized.length > 0 && !license.includes(normalized)) {
      license.push(normalized);
    }
  }

  const officialRaw = params.get("official");
  const official =
    officialRaw === "true" ? true : officialRaw === "false" ? false : null;

  const sortRaw = params.get("sort");
  const sort = SORTS.includes(sortRaw as SearchSort) ? (sortRaw as SearchSort) : undefined;

  const page = Number.parseInt(params.get("page") ?? "", 10);
  const pageSize = Number.parseInt(params.get("pageSize") ?? "", 10);

  return {
    q: (params.get("q") ?? "").trim(),
    filters: { kind, license, official },
    sort,
    page: Number.isFinite(page) ? page : 1,
    pageSize: Number.isFinite(pageSize) ? pageSize : undefined,
  };
}

/** 在当前条件上改几处后，拼出新的查询串（筛选 / 排序 / 分页链接用）。 */
export type SearchParamsPatch = {
  kind?: AssetKind[];
  license?: (string | null)[];
  official?: boolean | null;
  sort?: SearchSort;
  page?: number;
  pageSize?: number;
};

/**
 * 拼查询串。
 *
 * `patch` 里显式给 `null` 表示「清掉这个条件」（官方版本筛选用得上）。
 */
export function buildSearchParams(
  query: NormalizedQuery,
  patch: SearchParamsPatch = {},
): URLSearchParams {
  const params = new URLSearchParams();

  if (query.q.length > 0) {
    params.set("q", query.q);
  }

  for (const value of patch.kind ?? query.filters.kind) {
    params.append("kind", value);
  }
  for (const value of patch.license ?? query.filters.license) {
    params.append("license", value ?? UNDECLARED_LICENSE);
  }

  const official = patch.official === undefined ? query.filters.official : patch.official;
  if (official !== null) {
    params.set("official", String(official));
  }

  params.set("sort", patch.sort ?? query.sort);

  const page = patch.page ?? query.page;
  if (page > 1) {
    params.set("page", String(page));
  }

  const pageSize = patch.pageSize ?? query.pageSize;
  if (pageSize !== DEFAULT_PAGE_SIZE) {
    params.set("pageSize", String(pageSize));
  }

  return params;
}

/** 判断一个字符串是不是合法的资产分类。 */
export function isAssetKind(value: string): value is AssetKind {
  return (Object.values(AssetKind) as string[]).includes(value);
}

/**
 * Next.js 给的 `searchParams` 对象 → {@link URLSearchParams}。
 *
 * 页面（`/search` 与 `/mcp`）共用这一份转换：两边各写一遍再对齐，
 * 迟早会对不上（同一个参数名在两处解析成不同的东西）。
 */
export function toUrlSearchParams(
  raw: Record<string, string | string[] | undefined>,
): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        params.append(key, item);
      }
    } else if (value !== undefined) {
      params.append(key, value);
    }
  }
  return params;
}
