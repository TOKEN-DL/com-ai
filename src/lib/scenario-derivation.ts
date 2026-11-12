/**
 * 场景短语的派生规则（票 #12）。
 *
 * ## 这个文件负责什么
 *
 * 把一个资产已有的文字（「何时用」+ frontmatter 自述）变成一组**场景短语**，
 * 每条短语对应一张场景卡片。规则全是纯函数：不碰数据库、不读环境变量，
 * 同样的输入永远得到同样的输出 —— 这样规则可以被单元测试钉死
 * （见 test/scenario-derivation.test.ts）。
 *
 * ## 为什么要从「已有文字」里抽，而不是让模型再生成一遍
 *
 * 场景卡片是**社区冷启动**的答案：资讯模块后置、社区还没有现成内容可发，
 * 所以卡片必须能从已收录资产的「何时用」自动派生，**零额外采集成本**。
 * 也就是说：站上已经有的文字（票 #7 的「何时用」、上游作者自己写的 description）
 * 就是原料，我们只做**抽取**，不重新生成。
 *
 * ## 归一化与去重
 *
 * 去重键 = **NFKC → 小写 → 去掉所有空白 → 去掉所有标点与符号**。
 *
 * - NFKC：把全角/半角、兼容字符统一（「ＰＤＦ」与「pdf」视为同一个场景）；
 * - 小写：英文大小写不敏感；
 * - 去空白：「批量处理 PDF」与「批量处理PDF」是同一个场景；
 * - 去标点：「处理 PDF，批量」与「处理 PDF 批量」是同一个场景。
 *
 * 数据库侧还有一条唯一约束兜底（`ScenarioDetail(sourceAssetId, scenarioKey)`），
 * 所以**规则改了、重跑了一遍、两个来源抽出了同一句话**，都不会多出第二张卡片。
 */

/** 场景的派生来源。 */
export type ScenarioOrigin = "whenToUse" | "frontmatter";

/** 派生出来的一条场景。 */
export type DerivedScenario = {
  /// 场景短语原文（展示用）。
  text: string;
  /// 归一化后的去重键。
  key: string;
  /// 这条场景是从哪段文字派生的。
  origin: ScenarioOrigin;
};

/** 一个资产最多派生几张卡片。 */
const DEFAULT_MAX_PER_ASSET = 3;

/** 一段文字最多抽出几条场景。 */
const MAX_PHRASES_PER_TEXT = 2;

/** 场景短语的长度上限（字符）。太长的标题在卡片列表里没法看。 */
const MAX_PHRASE_LENGTH = 80;

/** 场景短语的长度下限（字符）。 */
const MIN_PHRASE_LENGTH = 4;

/**
 * 归一化：NFKC → 小写 → 去空白 → 去标点与符号。
 *
 * 去重就靠它 —— 同一句话的不同写法（大小写、全半角、多余空格、标点）必须落到同一个键上。
 */
export function normalizeScenarioKey(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/gu, "")
    .replace(/[\p{P}\p{S}]/gu, "");
}

/**
 * 「何时用」子句的识别规则。
 *
 * 命中时取**第一个捕获组**作为场景主体 —— 「Use when X」「当 X 时」「适用于 X」
 * 这类句式里，X 才是真正的「场景」，句子其余部分是在解释这个 skill 是干什么的。
 *
 * 顺序有讲究：中文规则在前（中文句子里不会有英文缩写），英文的 `use … when …`
 * 排在 `use … for/on/with/to …` 前面（前者信息量更大）。
 */
const WHEN_CLAUSE_PATTERNS: readonly RegExp[] = [
  // 中文：当……时
  /(?:当|在)([^；，。、？?！!]{2,40}?)时/u,
  // 中文：适用于 / 适合 / 用于
  /(?:适用于|适合|用于)([^；，。、？?！!]{2,40})/u,
  // 英文：Use … when …
  /\b(?:use|used|using)\b[^;]{0,60}?\bwhen\s+([^;]+)/iu,
  // 英文：when the user / the person / the developer …
  /\bwhen\s+(?:the\s+)?(?:user|person|developer|human|agent|you)\s+([^;]+)/iu,
  // 英文：Use it / this … before / after / if …
  /\buse\s+(?:it|this|these|that|them)\s+((?:before|after|while|if|unless|when)\s+[^;]+)/iu,
  // 英文：Use (this skill) for / on / with / to …
  /\buse\s+(?:this\s+(?:skill\s+)?)?(?:for|on|with|to)\s+([^;]+)/iu,
];

/** 句子切分：中文标点直接断；英文句号要「句号 + 空白 + 大写」才算断。 */
const SENTENCE_TERMINATORS = new Set(["。", "！", "？", "!", "?", ";", "；", "\n"]);

/** 英文缩写：这些词后面的句号不是句末（`e.g.` `i.e.` `etc.` `vs.` …）。 */
const ABBREVIATIONS = new Set([
  "e.g",
  "i.e",
  "etc",
  "vs",
  "cf",
  "mr",
  "mrs",
  "ms",
  "dr",
  "prof",
  "st",
  "no",
  "p.m",
  "a.m",
  "u.s",
]);

/**
 * 场景短语内部的切分符：逗号类、两侧带空格的破折号。
 *
 * ⚠️ **不在 " and " / " or " 上切**：那会把
 * 「wants to create or optimize an email sequence」切成
 * 「wants to create」+「optimize an email sequence」——
 * 前半截不是场景，只是被切碎的动词。
 */
const SEGMENT_SPLIT = /[,，、;；]|\s[-–—]\s/u;

/** 句子开头要去掉的引导词（它们不是场景本身）。 */
const LEADING_CONNECTIVES =
  /^(?:read\s+first\s+to|for\s+use\s+with|this\s+skill\s+(?:helps|should|is|can|will)|official|about|also|use|when|using|and|or|the|a|an)\s+/iu;

/** 结尾悬空的连词 / 介词（切分后残留的半个短语）。 */
const DANGLING_TAIL = /\s+(?:and|or|the|a|an|to|of|in|on|at|with|for|by)$/iu;

/**
 * 「方式 / 施事 / 地点」类介词：去掉之后主体基本不受影响，可以放心去掉。
 *
 * 例："render any video **with** HyperFrames" → "render any video"。
 */
const STRONG_PREPOSITIONS = new Set(["with", "by", "using", "via", "from", "at", "in", "on"]);

/**
 * 「目的 / 对象」类介词：去掉之后主体可能太空，要看情况。
 *
 * 例："user wants **to** X" 去掉 "to X" 就成了 "user wants" —— 那是废话。
 */
const WEAK_PREPOSITIONS = new Set(["for", "to", "of"]);

/**
 * 把一段文字切成句子。
 *
 * 中文标点（。！？；换行）直接断句；英文句号要满足「句号 + 空白 + 大写字母」，
 * 并且句号前面那个词不是缩写，才算句末 —— 否则 `e.g. Skills` 会被切成两半。
 */
export function splitSentences(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const sentences: string[] = [];
  let current = "";

  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    current += char;

    if (SENTENCE_TERMINATORS.has(char)) {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        sentences.push(trimmed);
      }
      current = "";
      continue;
    }

    if (char === "." && isEnglishSentenceEnd(normalized, i)) {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        sentences.push(trimmed);
      }
      current = "";
    }
  }

  const tail = current.trim();
  if (tail.length > 0) {
    sentences.push(tail);
  }

  return sentences;
}

/** 位置 i 上的英文句号是不是句末。 */
function isEnglishSentenceEnd(text: string, index: number): boolean {
  const next = text[index + 1];
  if (next === undefined || !/\s/.test(next)) {
    return false;
  }

  // 后面必须是空白 + 大写字母 / 引号 / 左括号，才像新句子的开头。
  const after = text.slice(index + 1).trimStart();
  if (after.length === 0 || !/^[A-Z"'(]/.test(after)) {
    return false;
  }

  // 句号前面那个词是缩写 → 不是句末。
  const before = text.slice(0, index);
  const word = /([A-Za-z.]+)$/.exec(before)?.[1]?.toLowerCase() ?? "";
  return !ABBREVIATIONS.has(word);
}

/** 去掉括号 / 方括号里的补充说明 —— 那是解释，不是场景。 */
function stripBrackets(text: string): string {
  return text.replace(/[(（[【][^)\]）】]*[)\]）】]/gu, " ");
}

/** 命中结果。 */
type WhenClause = {
  /// 「何时用」的内容。
  core: string;
};

/**
 * 命中「何时用」子句时返回它的内容，否则返回 null。
 *
 * 捕获组允许包含句号（"a figma.com link" 这种带点的不能被截断），
 * 截断交给 {@link firstSentence} 按句子边界做。
 */
function matchWhenClause(sentence: string): WhenClause | null {
  for (const pattern of WHEN_CLAUSE_PATTERNS) {
    const match = pattern.exec(sentence);
    const captured = match?.[1]?.trim();
    if (captured && captured.length > 0) {
      return { core: firstSentence(captured) };
    }
  }
  return null;
}

/** 取第一句（后面跟着的话不要了）。 */
function firstSentence(text: string): string {
  const sentences = splitSentences(text);
  return sentences[0] ?? text.trim();
}

/** 从一句话里挑出场景短语。 */
type PhraseMatch = {
  /// 场景短语。
  phrase: string;
  /// 这条短语是不是从「明确的何时用子句」里来的。
  explicit: boolean;
};

/**
 * 以「谓语动词」开头的片段是**半截话**，不是场景。
 *
 * "wants to plan" 只是 "the user wants to plan" 的后半截 ——
 * 拿它当卡片标题，读者根本不知道是谁要做什么。
 * 碰到这种片段就跳过，继续看后面的片段。
 */
const PREDICATE_STARTERS = new Set([
  "want",
  "wants",
  "need",
  "needs",
  "ask",
  "asks",
  "is",
  "are",
  "was",
  "were",
  "has",
  "have",
  "should",
  "would",
  "can",
  "could",
  "must",
  "shall",
  "may",
  "might",
  "will",
  "do",
  "does",
  "did",
  "be",
  "been",
  "being",
]);

/** 这个片段是不是以谓语动词开头（半截话）。 */
function startsWithPredicate(text: string): boolean {
  const first = text.split(/\s+/u)[0]?.toLowerCase().replace(/[^\p{L}]/gu, "") ?? "";
  return PREDICATE_STARTERS.has(first);
}

/**
 * 从一句话里挑出场景短语。
 *
 * 流程：
 *   1. 先看有没有「何时用」子句（有就取它的内容），再把整段清洗一遍；
 *   2. 整段够短够完整 → 直接用（"wants to plan, design, or implement an A/B test"
 *      这种整体就是一个场景，硬切反而会切出 "wants to plan" 这样的半截话）；
 *   3. 整段太长 → 按并列符切开，取**第一个站得住的片段**。
 *
 * 「站得住」= 长度达标、含实词、英文至少 3 个词（中文至少 4 个字）、
 * 而且不是以谓语动词开头的半截话。
 * 这么设门槛是为了跳过 "edit"、"make" 这类列表项 —— 它们是动作，不是场景。
 */
function pickPhrase(sentence: string): PhraseMatch | null {
  const when = matchWhenClause(sentence);
  const core = when?.core ?? sentence;

  const whole = cleanPhrase(stripBrackets(core));
  if (whole && isViablePhrase(whole) && !startsWithPredicate(whole)) {
    return { phrase: whole, explicit: when !== null };
  }

  for (const segment of stripBrackets(core).split(SEGMENT_SPLIT)) {
    const cleaned = cleanPhrase(segment);
    if (cleaned && isViablePhrase(cleaned) && !startsWithPredicate(cleaned)) {
      return { phrase: cleaned, explicit: when !== null };
    }
  }

  return null;
}

/** 找出结尾那个介词短语，返回「主体 + 介词 + 尾巴」。 */
function splitTrailingPrepositional(text: string): {
  head: string;
  prep: string;
  tail: string;
} {
  const pattern = /\s+(with|for|by|in|on|to|using|via|at|from|of)\s+/giu;
  let last: { index: number; prep: string; tail: string } | null = null;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    last = {
      index: match.index,
      prep: match[1].toLowerCase(),
      tail: text.slice(match.index + match[0].length).trim(),
    };
  }

  if (!last) {
    return { head: text, prep: "", tail: "" };
  }

  return { head: text.slice(0, last.index).trim(), prep: last.prep, tail: last.tail };
}

/**
 * 去掉介词短语之后的主体够不够看。
 *
 * 「方式 / 施事 / 地点」类介词（with / by / in …）去掉后主体通常还站得住，
 * 留 2 个词就行；「目的 / 对象」类介词（for / to / of）去掉后容易只剩半句话，
 * 主体至少要有 4 个词才值得 —— "task is specifically to prepare X" 砍成
 * "task is specifically" 就没有意义了。
 */
function isStrongEnough(text: string, strong: boolean): boolean {
  if (text.length < MIN_PHRASE_LENGTH) {
    return false;
  }
  if (hasCjk(text)) {
    return text.replace(/\s+/gu, "").length >= (strong ? 4 : 6);
  }
  return countWords(text) >= (strong ? 2 : 4);
}

/** 清洗一个候选片段。 */
function cleanPhrase(raw: string): string {
  const base = raw
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(LEADING_CONNECTIVES, "")
    .replace(DANGLING_TAIL, "")
    .replace(/^[\s,.;:、，。；：!?！？\-–—]+/u, "")
    .replace(/[\s,.;:、，。；：!?！？\-–—]+$/u, "")
    .trim();

  if (base.length === 0) {
    return base;
  }

  // 结尾的介词短语（"… with HyperFrames"）去掉后主体更干净；
  // 但去掉之后主体太空（"user wants"）就保留原样。
  //
  // 只在**尾巴很短**（≤ 3 个词）时去掉 —— "by frame against the original"
  // 这种长尾巴去掉之后会剩一个半截词（"… verify it frame"）。
  const { head, prep, tail } = splitTrailingPrepositional(base);
  if (prep && countWords(tail) <= 3) {
    const strong = STRONG_PREPOSITIONS.has(prep);
    const keep = strong ? isStrongEnough(head, true) : isStrongEnough(head, false);
    if (keep) {
      return head;
    }
  }

  return base;
}

/** 英文按词数、中文按字数。 */
function countWords(text: string): number {
  if (hasCjk(text)) {
    return text.replace(/\s+/gu, "").length;
  }
  return text.split(/\s+/u).filter(Boolean).length;
}

/** 文本里有没有中日韩字符。 */
function hasCjk(text: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text);
}

/** 一个片段能不能当场景短语。 */
function isViablePhrase(text: string): boolean {
  if (text.length < MIN_PHRASE_LENGTH || text.length > MAX_PHRASE_LENGTH) {
    return false;
  }
  if (!/[\p{L}\p{N}]/u.test(text)) {
    return false;
  }
  if (hasCjk(text)) {
    // 中文：至少 4 个字。
    return text.replace(/\s+/gu, "").length >= 4;
  }
  // 英文：至少 3 个词 —— "edit"、"make" 这类列表项不算场景。
  return countWords(text) >= 3;
}

/**
 * 从一段文字里抽出场景短语（最多 {@link MAX_PHRASES_PER_TEXT} 条）。
 *
 * 规则：
 *   - **第一句**总会给一条（它是这个 skill 的主用途）；
 *   - 后面的句子只有在**明确写了「何时用」**时才给一条 ——
 *     否则一句补充说明（"Holds the render contract"）也会变成一张没营养的卡片。
 */
export function extractScenarioPhrases(text: string | null | undefined): string[] {
  if (!text) {
    return [];
  }

  const phrases: string[] = [];
  const seen = new Set<string>();
  const sentences = splitSentences(text);

  for (let index = 0; index < sentences.length; index += 1) {
    if (phrases.length >= MAX_PHRASES_PER_TEXT) {
      break;
    }

    const match = pickPhrase(sentences[index]);
    if (!match) {
      continue;
    }

    if (index > 0 && !match.explicit) {
      continue;
    }

    const key = normalizeScenarioKey(match.phrase);
    if (key.length === 0 || seen.has(key)) {
      continue;
    }

    seen.add(key);
    phrases.push(match.phrase);
  }

  return phrases;
}

/** 从 frontmatter（JSON）里取 description。 */
export function readFrontmatterDescription(frontmatter: unknown): string | null {
  if (
    typeof frontmatter !== "object" ||
    frontmatter === null ||
    Array.isArray(frontmatter)
  ) {
    return null;
  }

  const description = (frontmatter as Record<string, unknown>).description;
  if (typeof description !== "string") {
    return null;
  }

  const trimmed = description.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** 派生入参。 */
export type DeriveScenariosInput = {
  /// 票 #7 的「何时用」（权威的场景表述）。
  whenToUse?: string | null;
  /// frontmatter（JSON）—— 取里面的 description。
  frontmatter?: unknown;
  /// 一个资产最多派生几张卡片。默认 3。
  maxPerAsset?: number;
};

/**
 * 从一个资产派生它的场景卡片内容。
 *
 * 两个来源按优先级排：
 *   1. **「何时用」**（票 #7 生成的中文场景表述）—— 权威；
 *   2. **frontmatter.description**（上游作者自己写的描述）—— 兜底。
 *
 * **先到先得**：哪个来源先抽出了场景，就只用那个来源的 ——
 * 一个 skill 不该同时产出「中文场景」和「英文场景」两张几乎一样的卡片。
 * 两个来源抽出同一句话时（归一化之后键相同），也只保留先到的那个，
 * 所以同一个资产 + 同一个场景永远只有一张卡片。
 */
export function deriveScenarios(input: DeriveScenariosInput): DerivedScenario[] {
  const max = input.maxPerAsset ?? DEFAULT_MAX_PER_ASSET;
  const scenarios: DerivedScenario[] = [];
  const seen = new Set<string>();

  const push = (text: string, origin: ScenarioOrigin): void => {
    if (scenarios.length >= max) {
      return;
    }

    const key = normalizeScenarioKey(text);
    if (key.length === 0 || seen.has(key)) {
      return;
    }

    seen.add(key);
    scenarios.push({ text, key, origin });
  };

  const fromWhenToUse = extractScenarioPhrases(input.whenToUse);
  if (fromWhenToUse.length > 0) {
    for (const phrase of fromWhenToUse) {
      push(phrase, "whenToUse");
    }
    return scenarios;
  }

  for (const phrase of extractScenarioPhrases(readFrontmatterDescription(input.frontmatter))) {
    push(phrase, "frontmatter");
  }

  return scenarios;
}
