/**
 * 排序选项与展示名（票 #24）。
 *
 * ## 为什么是单独一份
 *
 * 排序维度以前在 `/search`、`/mcp`、`/prompts`、`/scenarios`、`/skills`
 * 五个页面各写了一份 `SORT_LABELS` + `SORT_OPTIONS`。加一个排序口径要改五个页面，
 * 漏掉一个就会出现「有的页面能选、有的页面选不到」的不一致 —— 这类活不该靠记性维持。
 *
 * 现在标签与选项都在这里定义，页面只引用。
 */
import type { AssetKind } from "@prisma/client";

import { defaultSortFor, type SearchSort } from "@/lib/search-service";

/** 排序维度的展示名。 */
export const SORT_LABELS: Record<SearchSort, string> = {
  relevance: "相关度",
  heat: "热度",
  recent: "更新时间",
  name: "名称",
  installs: "安装量",
  trending: "近期增速",
};

/** 基础排序维度：任何分类都有意义。 */
const BASE_SORTS: readonly SearchSort[] = ["relevance", "heat", "recent", "name"];

/**
 * 有安装量口径的分类（spec 决策 5 的 all-time / trending 视图，票 #24）。
 *
 * MCP / PROMPT 没有安装量概念（`installs` 恒为 0），给它们「安装量」「近期增速」
 * 是噪音而不是功能 —— 所以这两类只提供基础排序。
 *
 * SCENARIO 卡片继承源资产的安装量与增速，所以算有。
 */
const INSTALL_SORT_KINDS: readonly AssetKind[] = ["SKILL", "SCENARIO"];

/**
 * 按分类过滤排序选项。
 *
 * - 不传分类 / 分类为空 → 跨类型浏览，六个选项都给。
 * - 选了只有 MCP / PROMPT 的分类 → 只给基础四个。
 * - 混合分类（SKILL + MCP）→ 给全部六个：SKILL 那部分按安装量排序有意义，
 *   MCP 那部分（安装量恒为 0）自然排在后面。
 */
export function sortOptionsForKinds(kinds?: readonly AssetKind[]): SearchSort[] {
  const hasInstallSort =
    !kinds || kinds.length === 0 || kinds.some((kind) => INSTALL_SORT_KINDS.includes(kind));
  return hasInstallSort ? [...BASE_SORTS, "installs", "trending"] : [...BASE_SORTS];
}

/**
 * 把请求里的排序维度落到当前页面可用的选项上。
 *
 * URL 里的 `sort` 可以手写 —— 指向本页不支持的口径时（比如在 `/mcp` 上写
 * `?sort=installs`），退回默认口径，**让下拉框显示的与实际排序一致**。
 * 页面拿不准用户到底想要什么的时候，猜一个不如老老实实退回默认。
 */
export function resolvePageSort(
  sort: SearchSort | undefined,
  options: readonly SearchSort[],
  q: string,
): SearchSort {
  if (sort && options.includes(sort)) {
    return sort;
  }
  const fallback = defaultSortFor(q);
  return options.includes(fallback) ? fallback : options[0];
}
