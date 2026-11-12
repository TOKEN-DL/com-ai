/**
 * 中文简介生成端口（spec 决策 7「中文简介生成」）。
 *
 * ## 这个文件是**端口（port）**，不是一个实现
 *
 * spec 的「Testing Decisions」把 LLM 生成明确划成一个端口：
 * 测试里注入确定性假实现，断言流水线存下了它返回的内容并正确标记 `summarySource`；
 * 另有一条默认跳过的契约测试打真实 DeepSeek。
 *
 * 真实实现（DeepSeek，OpenAI 兼容协议）在 {@link file://./deepseek-summary-generator.ts}。
 * 采集器（#6）与用户发布（#11）都只认这里的**接口**，不认具体实现 ——
 * 换模型、换供应商时只改实现文件。
 *
 * ## 形状约定（#7 若另起一份实现，请对齐这一份）
 *
 * 输入：资产正文 + 元信息（名字、类型、仓库、许可证、用户自己写的简介）。
 * 输出：一段结构化初稿 —— 中文简介 / 何时用 / 怎么用 / 分类标签建议 + **来源标记**。
 *
 * 「来源标记」用的是数据库里已有的 `SummarySource` 枚举：
 *   LLM     —— AI 生成的初稿（页面必须标注「AI 生成，版权归原作者」）；
 *   TEMPLATE —— 模板降级（LLM 挂了或没配 key 时的兜底）；
 *   HUMAN   —— 人工撰写（用户自己写的那段）。
 */
import type { AssetKind, SummarySource } from "@prisma/client";

import { createDefaultSummaryGenerator } from "@/lib/deepseek-summary-generator";

/** 生成器的输入：资产正文与元信息。 */
export type SummaryGeneratorInput = {
  /// 资产类型。
  kind: AssetKind;
  /// 展示名（英文原文名）。
  displayName: string;
  /// 资产正文（SKILL.md / MCP 配置 / 提示词）。
  /// ⚠️ 只有 FULL 档位才有值；METADATA_ONLY 档位一定是 null
  ///    （站内不复制原文，也不生成基于原文的简介）。
  contentBody: string | null;
  /// 资产正文的内容 hash。
  ///
  /// **#7（中文简介）用得上**：按内容 hash 缓存，避免同一份内容重复调模型。
  /// 一期（#11）只是把它算出来递给端口，不做缓存 —— 缓存是 #7 的活。
  contentHash?: string | null;
  /// 来源标识（如 "skills.sh" / "user"）：这条资产是从哪儿来的。
  /// 留给 #7 做「同一份内容换个来源就别重复生成」这类判断。
  sourceId?: string | null;
  /// 用户自己写的简介（一句话）。人工来源，不基于原文。
  description: string | null;
  /// 来源仓库的 owner / name。
  repoOwner: string | null;
  repoName: string | null;
  /// SPDX 许可证 id（null = 未声明）。
  license: string | null;
  /// 模态（PROMPT 专有）：TEXT / MUSIC / VIDEO / IMAGE。
  ///
  /// 站上 6348 条 PROMPT 的 `act` 恒等于标题（同义反复，零信息量），
  /// 真正回答得了「什么时候该用它」的是**模态 + 目标工具**（票 #26）。
  modality?: string | null;
  /// 目标工具 / 模型标签（PROMPT 专有）：suno / seedance / chatgpt …
  toolTags?: string[];
};

/** 生成结果：结构化的中文简介初稿。 */
export type SummaryDraft = {
  /// 中文简介（一段话）。
  summaryZh: string;
  /// 「何时用」——什么时候该用它。
  whenToUse: string | null;
  /// 「怎么用」——装上之后怎么用。
  howToUse: string | null;
  /// 分类标签建议（供运营 / 二期筛选用；一期只存不展示）。
  tags: string[];
  /// 来源标记：LLM / TEMPLATE（HUMAN 由人工撰写路径直接写库，不经本端口）。
  source: SummarySource;
};

/**
 * 中文简介生成端口。
 *
 * 实现方**不允许抛异常阻断业务**：调用方会兜底，但实现自己也应当降级
 * （LLM 挂了 → 返回 `source = "TEMPLATE"` 的模板初稿）。
 */
export interface SummaryGenerator {
  generate(input: SummaryGeneratorInput): Promise<SummaryDraft>;
}

const KIND_LABELS: Record<AssetKind, string> = {
  SKILL: "Skill",
  MCP: "MCP Server",
  PROMPT: "Prompt",
  SCENARIO: "场景卡片",
};

/**
 * 模态 → 中文标签与「何时用」的组句模板（票 #26）。
 *
 * PROMPT 的素材是「一条音乐 / 视频 / 图片 / 文本提示词」+「目标是哪个工具」，
 * 所以句子按模态组、带上这条提示词自己的标题 —— 不是把一句模板套 6348 遍。
 */
const MODALITY_TEMPLATES: Record<string, { label: string; phrase: string }> = {
  MUSIC: { label: "音乐", phrase: "生成一段「{title}」风格的音乐" },
  VIDEO: { label: "视频", phrase: "生成一段「{title}」风格的视频" },
  IMAGE: { label: "图片", phrase: "生成一张「{title}」风格的图片" },
  TEXT: { label: "文本", phrase: "完成「{title}」这类任务" },
};

/**
 * **不是工具**的标签。
 *
 * `video-as-prompt` 是「这条提示词是拿来生成视频的」这一类**标记**，
 * 不是某个工具 —— 它和 wan / cogview4 一起出现。
 * 把它当成工具写进句子会读成「用 视频转提示词 生成一段视频」，是错的。
 */
const NON_TOOL_TAGS = new Set(["video-as-prompt"]);

/**
 * 目标工具标签 → 展示名。
 *
 * 不认识的标签**原样输出**，不编造名字（站内没有收录过的工具不能瞎写）。
 */
const TOOL_LABELS: Record<string, string> = {
  chatgpt: "ChatGPT",
  suno: "Suno",
  seedance: "Seedance",
  "seedance-2": "Seedance 2",
  cogview4: "CogView 4",
  cogvideox: "CogViewX",
  musicgen: "MusicGen",
  "stable-audio": "Stable Audio",
  "minimax-music-3": "MiniMax Music 3",
  musicfx: "MusicFX",
  flux: "Flux",
  "flux-3": "Flux 3",
  udio: "Udio",
  wan: "Wan",
  "hunyuan-video": "混元视频",
};

/** 取目标工具的展示名列表（去掉非工具标签、去重、保序）。 */
export function formatToolLabels(toolTags: string[] | undefined): string[] {
  const labels: string[] = [];
  for (const tag of toolTags ?? []) {
    if (NON_TOOL_TAGS.has(tag)) {
      continue;
    }
    const label = TOOL_LABELS[tag] ?? tag;
    if (!labels.includes(label)) {
      labels.push(label);
    }
  }
  return labels;
}

/**
 * PROMPT 的模板初稿（票 #26）。
 *
 * 与其它类型不同，PROMPT 的素材不是「作者自述」而是「模态 + 目标工具」：
 * 站上 6348 条 PROMPT 的 `act` 恒等于标题（零信息量），
 * 真正回答得了「什么时候该用它」的是模态与工具。
 *
 * **作者自己写过的话仍然优先** —— 用户发布的资产走这条路
 * （`description` 来自发布表单，不是采集来的）。
 */
function promptTemplateDraft(input: SummaryGeneratorInput): SummaryDraft {
  const where =
    input.repoOwner && input.repoName ? `${input.repoOwner}/${input.repoName}` : "未知来源";
  const description = (input.description ?? "").trim();
  const modality = MODALITY_TEMPLATES[input.modality ?? ""] ?? null;
  const tools = formatToolLabels(input.toolTags);
  const toolText = tools.length > 0 ? tools.join("、") : null;

  const summaryZh =
    description.length > 0
      ? `来自 ${where} 的 Prompt「${input.displayName}」，${description}`
      : `来自 ${where} 的 Prompt「${input.displayName}」，是一份` +
        (modality
          ? toolText
            ? `${modality.label}类提示词，面向 ${toolText}。`
            : `${modality.label}类通用提示词。`
          : "提示词。");

  const whenToUse =
    description.length > 0
      ? `适用于：${description}`
      : modality
        ? toolText
          ? `当你需要用 ${toolText} ${modality.phrase.replace("{title}", input.displayName)}时。`
          : `当你需要一份${modality.label}类提示词时。`
        : "当你需要一份提示词时。";

  const howToUse = toolText
    ? `在详情页复制提示词正文，粘贴到 ${toolText} 里直接使用。`
    : "在详情页复制提示词正文后直接使用。";

  return {
    summaryZh,
    whenToUse,
    howToUse,
    tags: [],
    source: "TEMPLATE",
  };
}

/**
 * 模板降级初稿（纯函数，不联网、不看环境变量）。
 *
 * 什么时候用：
 *   - LLM 调用失败 / 超时 / 返回结构不对；
 *   - 根本没配 LLM 凭据；
 *   - 用户声明的许可证不允许再分发（不生成基于原文的简介）。
 *
 * 模板文案**不引用正文**，只引用元信息与用户自己写的那句话 ——
 * 所以它在 METADATA_ONLY 档位下也是安全的。
 *
 * PROMPT 走自己的一条路（票 #26）：它的素材是模态 + 目标工具，不是作者自述。
 */
export function templateSummaryDraft(input: SummaryGeneratorInput): SummaryDraft {
  if (input.kind === "PROMPT") {
    return promptTemplateDraft(input);
  }

  const where =
    input.repoOwner && input.repoName ? `${input.repoOwner}/${input.repoName}` : "未知来源";
  const kindLabel = KIND_LABELS[input.kind] ?? "资产";
  const description = (input.description ?? "").trim();

  const base = `来自 ${where} 的 ${kindLabel}「${input.displayName}」。`;
  const summaryZh = description.length > 0 ? `${base}${description}` : base;

  return {
    summaryZh,
    whenToUse: description.length > 0 ? `适用于：${description}` : null,
    howToUse:
      input.repoOwner && input.repoName
        ? `克隆 ${where} 仓库后按其 README 安装与配置。`
        : null,
    tags: [],
    source: "TEMPLATE",
  };
}

/** 永远返回模板初稿的生成器（没配 LLM 凭据时用它）。 */
export class TemplateSummaryGenerator implements SummaryGenerator {
  async generate(input: SummaryGeneratorInput): Promise<SummaryDraft> {
    return templateSummaryDraft(input);
  }
}

/**
 * 端口的注入点。
 *
 * 测试用 `setSummaryGenerator(假实现)` 换掉默认实现（spec 的 port 约定）；
 * 生产代码不需要碰它 —— 走 {@link getSummaryGenerator} 的默认实现。
 */
let override: SummaryGenerator | null = null;

/** 换掉默认实现；传 null 恢复默认。 */
export function setSummaryGenerator(generator: SummaryGenerator | null): void {
  override = generator;
}

/** 取当前生效的生成器（测试注入优先）。 */
export function getSummaryGenerator(): SummaryGenerator {
  if (override) {
    return override;
  }
  return defaultGenerator();
}

/**
 * 默认实现：配了 DEEPSEEK_API_KEY 就走 DeepSeek，否则走模板。
 *
 * 真正的实现在另一个文件里 —— 这里只做「有没有凭据」的判断，
 * 免得这个端口文件同时背上 HTTP 调用的细节。
 *
 * ⚠️ 两个文件互相 import（实现要端口的模板函数，端口要实现的构造器），
 *    构成一个**运行时循环依赖**。这是安全的：两边都只在**函数体里**用对方的
 *    绑定（模块求值阶段不碰），ESM 的 TDZ 因此不会踩到。
 *    如果 #7 要重构这个端口，注意别把它变成「模块顶层就调用对方」的形式。
 */
function defaultGenerator(): SummaryGenerator {
  return createDefaultSummaryGenerator();
}
