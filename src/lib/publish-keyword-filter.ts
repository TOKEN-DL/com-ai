/**
 * 发布内容的自动关键词过滤（spec 决策 11 的第一道关口）。
 *
 * ## 为什么要有它
 *
 * 审核链路是「自动关键词过滤 → 用户举报 → 人工抽查」，**不做全量预审队列**
 * （单人运营下预审会立刻成为瓶颈）。所以站里必须有一道**不需要人**的自动关口，
 * 否则任何人都能把垃圾内容挂到市场上再等人工清理。
 *
 * ## 它只管用户自己写的字
 *
 * 过滤对象是**用户提交的文本**（名称 + 简介）。
 * AI 生成的简介初稿**不过滤** —— 那是我们自己的产出，
 * 而且正文里出现某个词未必是违规（比如在讲「如何识别诈骗」）。
 *
 * ## 命中之后会发生什么
 *
 * 命中 → 这条发布记录进 `PENDING`（审核中）状态，资产被下架，等运营抽查。
 * 运营放行 → `PUBLISHED`；运营判定违规 → `REJECTED`。
 *
 * ## 名单从哪来
 *
 * 内置名单只是一份**起步清单**，通过环境变量 `PUBLISH_BLOCKED_KEYWORDS`
 * 可以追加（逗号分隔）。名单永远不写死在代码里当唯一依据 ——
 * 运营调整名单不需要改代码。
 */

export type PublishFilterCategory = "引流" | "垃圾" | "违法" | "色情" | "赌博" | "其他";

export type PublishFilterResult = {
  /// 是否命中过滤。
  hit: boolean;
  /// 命中的关键词（给运营看，发布者看的是原因说明）。
  matched: string[];
  /// 人类可读的原因；没命中时是 null。
  reason: string | null;
};

/** 内置的起步名单。刻意保守：宁可漏判（人工抽查兜底），也不误伤正常内容。 */
const BUILTIN_KEYWORDS: { keyword: string; category: PublishFilterCategory }[] = [
  { keyword: "加微信", category: "引流" },
  { keyword: "加v信", category: "引流" },
  { keyword: "加薇信", category: "引流" },
  { keyword: "私聊出售", category: "引流" },
  { keyword: "代开发票", category: "违法" },
  { keyword: "刷单", category: "垃圾" },
  { keyword: "兼职日结", category: "垃圾" },
  { keyword: "色情", category: "色情" },
  { keyword: "博彩", category: "赌博" },
  { keyword: "casino", category: "赌博" },
  { keyword: "buy followers", category: "垃圾" },
  { keyword: "crypto giveaway", category: "垃圾" },
];

/** 读环境变量里追加的关键词（逗号分隔）。 */
function extraKeywords(): { keyword: string; category: PublishFilterCategory }[] {
  const raw = process.env.PUBLISH_BLOCKED_KEYWORDS;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return [];
  }
  return raw
    .split(/[,，\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((keyword) => ({ keyword, category: "其他" as PublishFilterCategory }));
}

/** 当前生效的关键词名单（内置 + 环境变量追加）。 */
export function blockedKeywords(): { keyword: string; category: PublishFilterCategory }[] {
  return [...BUILTIN_KEYWORDS, ...extraKeywords()];
}

/**
 * 对一段用户提交的文本做关键词过滤。
 *
 * 纯函数（除了读环境变量），可以在单元测试里直接调。
 */
export function filterPublishText(text: string): PublishFilterResult {
  if (typeof text !== "string" || text.trim().length === 0) {
    return { hit: false, matched: [], reason: null };
  }

  // 统一小写后匹配，避免大小写绕过（"Casino" / "CASINO"）。
  const haystack = text.toLowerCase();
  const matched: { keyword: string; category: PublishFilterCategory }[] = [];

  for (const entry of blockedKeywords()) {
    if (haystack.includes(entry.keyword.toLowerCase()) && !matched.some((m) => m.keyword === entry.keyword)) {
      matched.push(entry);
    }
  }

  if (matched.length === 0) {
    return { hit: false, matched: [], reason: null };
  }

  const categories = [...new Set(matched.map((entry) => entry.category))];
  const keywords = matched.map((entry) => entry.keyword);

  return {
    hit: true,
    matched: keywords,
    reason: `命中自动过滤关键词（${categories.join("、")}）：${keywords.join("、")}`,
  };
}
