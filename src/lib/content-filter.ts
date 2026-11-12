/**
 * 自动关键词过滤 —— 审核链路的第一环（spec 决策 11）。
 *
 * 审核链路 = **自动关键词过滤** → 用户举报 → 运营抽查。
 * 刻意**不做**「所有新帖先进待审队列」：单人运营下那会立刻成为瓶颈，
 * 所以正常评论默认直接公开，只有命中过滤词的才被拦下。
 *
 * 命中过滤词的评论**不公开**，但会以 `CommentStatus.PENDING` 落库，
 * 并把命中的词记进 `Comment.filteredReason` —— 运营在抽查入口能看到它，
 * 决定是放行（→ VISIBLE）还是隐藏（→ HIDDEN）。
 *
 * ## 词表来源
 *
 * 手工整理的**种子词表**，取自中文技术社区常见的垃圾推广话术：
 * 引流索要联系方式、代办灰产、兼职刷单、博彩色情、招商加盟五类。
 * 刻意只收**语义明确**的短语，避免误伤正常技术讨论 ——
 * 例如不用「扫码」「免费」「包过」这类正常讨论里也会出现的词。
 *
 * 词表就放在本文件里（改词 = 改代码 + 走一次发布）。后续若要做「运营
 * 在后台热改词表」，再把它挪成一张表 —— 那时同时要处理测试库的清库
 * 白名单（见 test/helpers/db.ts 的 PRESERVED_TABLES）。
 */

/**
 * 过滤词表：命中即拦截。
 *
 * ⚠️ 词条里**不能有空白** —— 比较前正文会被归一化（去掉所有空白），
 *    词表带空白就永远匹配不上。
 */
export const BLOCKED_KEYWORDS: readonly string[] = [
  // ── 引流 / 索要联系方式 ──
  "加微信",
  "加薇信",
  "加v信",
  "加qq",
  "加扣扣",
  "扣扣",
  "私聊获取",
  "私信获取",
  "扫码进群",

  // ── 代办 / 灰产 ──
  "代开发票",
  "代开票",
  "代实名",
  "代认证",
  "接码平台",
  "专业破解",
  "破解版下载",
  "出售账号",
  "收售账号",

  // ── 兼职 / 刷单 / 博彩 ──
  "兼职刷单",
  "刷单返利",
  "日赚",
  "月入过万",
  "一夜暴富",
  "稳赚不赔",
  "博彩",
  "菠菜",
  "赌钱",
  "送彩金",

  // ── 色情 ──
  "色情",
  "裸聊",

  // ── 招商 ──
  "招商加盟",
  "招代理",
  "代理加盟",
  "内部渠道",
];

/**
 * 归一化：全角转半角（NFKC）、转小写、**去掉所有空白**。
 *
 * 去空白是为了挡住「加 微 信」这类插空格的规避手法：词表与正文用
 * 同一套归一化，比较的就是同一形态。
 */
export function normalizeForFilter(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

/** 预归一化的词表：避免每次比对都重算。 */
const NORMALIZED_KEYWORDS: readonly { word: string; needle: string }[] = BLOCKED_KEYWORDS.map(
  (word) => ({ word, needle: normalizeForFilter(word) }),
);

/**
 * 命中的过滤词（全部，按词表顺序），没命中返回空数组。
 *
 * 命中词要拿给**运营**看（`Comment.filteredReason`），
 * 但**不给普通用户看** —— 告诉用户命中了哪个词等于教他怎么绕过去。
 */
export function findBlockedKeywords(text: string): string[] {
  const normalized = normalizeForFilter(text);
  return NORMALIZED_KEYWORDS.filter((entry) => normalized.includes(entry.needle)).map(
    (entry) => entry.word,
  );
}

/** 第一个命中的过滤词；没命中返回 null。 */
export function findBlockedKeyword(text: string): string | null {
  return findBlockedKeywords(text)[0] ?? null;
}

/** 是否命中过滤词。 */
export function isBlocked(text: string): boolean {
  return findBlockedKeyword(text) !== null;
}
