/**
 * 检索层的**唯一入口契约**（spec 决策 8「检索层」）。
 *
 * 全站只有这一个接口能检索资产。页面、API 路由、下游的 #7（中文简介）、
 * #12（场景卡片）、#13/#14（MCP / Prompt 库）都只认这里签名的形状，
 * 不认任何具体实现 —— 后期整体换成向量检索时，调用方一行都不用改。
 *
 * ## 接口签名
 *
 * ```ts
 * export interface SearchService {
 *   search(query: SearchQuery): Promise<SearchResult>;
 * }
 * ```
 *
 * ## 入参（{@link SearchQuery}）
 *
 * | 字段 | 类型 | 说明 |
 * | --- | --- | --- |
 * | `q` | `string` | 查询词（自然语言关键词）。空串 = 纯浏览，不按关键词过滤。 |
 * | `filters` | {@link SearchFilters} | 过滤条件（分类 / 许可证 / 是否有官方版本 / 依赖了谁）。 |
 * | `sort` | {@link SearchSort} | 排序维度。默认：有查询词时按相关度，否则按热度。 |
 * | `page` | `number` | 页码，从 1 开始。默认 1。 |
 * | `pageSize` | `number` | 每页条数。默认 20，上限 100。 |
 *
 * ## 出参（{@link SearchResult}）
 *
 * | 字段 | 类型 | 说明 |
 * | --- | --- | --- |
 * | `items` | `SearchHit[]` | 当前页的结果条目（已按 `sort` 排好）。 |
 * | `total` | `number` | 命中总数（不受分页影响）。 |
 * | `page` / `pageSize` / `totalPages` | `number` | 分页信息。 |
 * | `facets` | {@link SearchFacets} | 分面：各筛选维度上的可选值与命中数量。 |
 * | `query` | {@link NormalizedQuery} | 归一化后的入参回显（便于前端回填筛选条）。 |
 *
 * ## 约定
 *
 * - 结果条目是**检索层的最小视图**：不含正文、不含扩展表字段。详情由详情页自己取。
 * - `facets` 的分面计数按「**除该维度自身以外**的全部筛选条件」计算
 *   （钻取语义）：选了 `kind=SKILL` 时，许可证分面仍显示其他类型下的许可证分布。
 * - 未声明许可证（`Asset.license` 为 null）在过滤条件里用 `null` 表示，
 *   在 URL 里用 {@link UNDECLARED_LICENSE} 这个哨兵值表示。
 * - 归档条目（`Asset.archivedAt` 非空）**永远不出现在结果里**。
 * - 依赖关系（票 #17）既是一个**筛选条件**（`filters.dependsOn`），
 *   也是关键词命中的一条**通道**（查「PDF 处理」时，依赖了 PDF 工具的资产也算命中）。
 */
import type { AssetKind, ContentTier } from "@prisma/client";

import { PostgresSearchService } from "@/lib/search-postgres";

/**
 * 未声明许可证（`Asset.license` 为 null）在 URL / 查询参数里的哨兵值。
 *
 * 过滤条件本身用 `null` 表示「未声明许可证」，这个字符串只是它在
 * URL 里（`?license=__none__`）的写法。
 */
export const UNDECLARED_LICENSE = "__none__";

/** 排序维度。 */
export type SearchSort = "relevance" | "heat" | "recent" | "name";

/** 过滤条件（分面矩阵：分类 × 许可证 × 是否有官方版本）。 */
export type SearchFilters = {
  /** 分类：资产类型。不传 / 空数组 = 跨类型。 */
  kind?: AssetKind[];
  /**
   * 许可证：SPDX id（小写）。
   *
   * `null` 表示「未声明许可证」（`Asset.license IS NULL`）；不传 / 空数组 = 不限。
   */
  license?: (string | null)[];
  /**
   * 是否有官方版本。`undefined` / `null` = 不限。
   *
   * 用 `null` 而不是只留 `undefined`，是为了让「显式清掉这个条件」
   * （拼筛选链接时）也有个说法。
   */
  official?: boolean | null;
  /**
   * 依赖筛选（票 #17）：只返回**依赖了这些资产**的条目。
   *
   * 值是被依赖资产在平台上的 slug。不传 / 空数组 = 不限。
   *
   * ## 为什么要它
   *
   * 票里写的是「依赖了 PDF 处理能力的资产」这种**按能力找依赖方**的需求。
   * 光靠关键词只能间接命中（见实现里的「依赖目标文本」通道），
   * 有了这个参数就能**精确**地说「我要看依赖了 pdf-batch-processor 的资产」。
   */
  dependsOn?: string[];
};

/** 检索入参。 */
export type SearchQuery = {
  /** 查询词。空串 = 纯浏览（不按关键词过滤）。 */
  q: string;
  /** 过滤条件。 */
  filters?: SearchFilters;
  /** 排序维度。 */
  sort?: SearchSort;
  /** 页码，从 1 开始。 */
  page?: number;
  /** 每页条数。 */
  pageSize?: number;
};

/** 结果条目（检索层的最小视图）。 */
export type SearchHit = {
  id: string;
  slug: string;
  kind: AssetKind;
  displayName: string;
  summaryZh: string | null;
  /// 「何时用」（票 #7）。搜索结果项要把它与「怎么用」分开显示。
  whenToUse: string | null;
  /// 「怎么用」（票 #7）。
  howToUse: string | null;
  license: string | null;
  contentTier: ContentTier;
  isOfficial: boolean;
  heatScore: number;
  installs: number;
  stars: number;
  repoOwner: string | null;
  repoName: string | null;
  repoUrl: string | null;
  updatedAt: Date;
  /** 相关度得分（仅 `sort=relevance` 时有意义；其余排序下恒为 0）。 */
  score: number;
};

/** 一个分面桶：某个可选值 + 命中数量。 */
export type SearchFacetBucket = {
  /**
   * 回填到筛选条件里的值。
   *
   * 许可证分面里，`null` 表示「未声明许可证」（回填时用 {@link UNDECLARED_LICENSE}）。
   */
  value: string | null;
  /** 命中数量。 */
  count: number;
};

/** 各筛选维度上的分面。 */
export type SearchFacets = {
  /** 分类分面。 */
  kind: SearchFacetBucket[];
  /** 许可证分面。 */
  license: SearchFacetBucket[];
  /** 是否有官方版本分面（`value` 为 `"true"` / `"false"`）。 */
  official: SearchFacetBucket[];
};

/** 归一化后的入参回显。 */
export type NormalizedQuery = {
  q: string;
  filters: {
    kind: AssetKind[];
    license: (string | null)[];
    official: boolean | null;
    /**
     * 依赖筛选（票 #17）。
     *
     * ⚠️ **没有依赖筛选时这个键不出现**（不是空数组）：
     *    归一化后的结构是公开契约（接口直接把它回给调用方），
     *    平白多出一个空数组会让既有调用方对不上。
     */
    dependsOn?: string[];
  };
  sort: SearchSort;
  page: number;
  pageSize: number;
};

/** 检索出参。 */
export type SearchResult = {
  items: SearchHit[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  facets: SearchFacets;
  query: NormalizedQuery;
};

/**
 * 全站唯一的检索入口。
 *
 * 实现与调用方解耦：换实现（→ 向量检索）只需要改 {@link getSearchService}，
 * 调用方拿到的类型形状不变。
 */
export interface SearchService {
  search(query: SearchQuery): Promise<SearchResult>;
}

/**
 * 当前生效的检索实现。
 *
 * ⚠️ 这是**换实现的唯一位置**：换成向量检索时，只改这里的返回值，
 *    其余代码（页面、API 路由、下游票）一行都不用动。
 */
export function getSearchService(): SearchService {
  return new PostgresSearchService();
}
