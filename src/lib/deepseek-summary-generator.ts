/**
 * DeepSeek 版的中文简介生成（spec 决策 2：LLM 用 DeepSeek，OpenAI 兼容协议）。
 *
 * 端口在 {@link file://./summary-generator.ts}；这里是**实现**。
 * 换模型 / 换供应商只改这个文件，调用方（采集器 #6、用户发布 #11）不用动。
 *
 * 三条硬规矩：
 *   1. **失败不抛错**：网络挂了、超时了、返回的不是 JSON —— 一律降级成模板初稿
 *      （`source = "TEMPLATE"`），绝不阻断入库（spec 决策 7）。
 *   2. **密钥只从环境变量读**：绝不写进代码、绝不提交进仓库。
 *   3. **不编造**：提示词要求只根据给到的材料写，不确定就写「暂不明确」。
 */
import {
  type SummaryDraft,
  type SummaryGenerator,
  type SummaryGeneratorInput,
  templateSummaryDraft,
} from "@/lib/summary-generator";

/** 默认的 DeepSeek 端点（OpenAI 兼容协议）。 */
const DEFAULT_BASE_URL = "https://api.deepseek.com";
/** 默认模型。 */
const DEFAULT_MODEL = "deepseek-chat";
/** 默认超时：生成一段几百字的简介，20 秒足够。 */
const DEFAULT_TIMEOUT_MS = 20_000;
/** 提示词里送进去的正文上限（再长模型也用不完，还费 token）。 */
const MAX_CONTENT_CHARS = 8_000;

export type DeepSeekSummaryGeneratorOptions = {
  /// API key。默认读环境变量 DEEPSEEK_API_KEY。
  apiKey?: string | null;
  /// 端点基址。默认 https://api.deepseek.com。
  baseUrl?: string;
  /// 模型名。默认 deepseek-chat。
  model?: string;
  /// 超时毫秒。默认 20000。
  timeoutMs?: number;
  /// 注入 fetch（测试用）。
  fetchImpl?: typeof fetch;
};

function envString(name: string): string | null {
  const value = process.env[name];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** 读一个正整数环境变量；没配或不合理就用兜底值。 */
function envInt(name: string, fallback: number): number {
  const raw = envString(name);
  if (raw === null) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** 构造提示词：只给模型看得到的东西，不给正文以外的任何内部信息。 */
export function buildSummaryPrompt(input: SummaryGeneratorInput): {
  system: string;
  user: string;
} {
  const system = [
    "你是 com-ai 平台的中文简介撰写助手。",
    "你的任务是根据给定材料，为一个 AI Agent 资产写一份**中文**简介初稿。",
    "严格输出 JSON，不要输出任何解释文字或 Markdown 代码块。",
    "JSON 结构：",
    '{"summaryZh":"一段话中文简介","whenToUse":"何时用（一到两句）","howToUse":"怎么用（一到两句）","tags":["分类标签","..."]}',
    "要求：",
    "1. 只依据给定材料写；材料里没有的信息一律写「暂不明确」，不要编造功能。",
    "2. 面向中文开发者，语言简洁具体，不要营销腔。",
    "3. 不要逐字大段复制原文，只提炼要点。",
    "4. tags 给 1 到 4 个中文分类标签（如「文档处理」「代码审查」）。",
  ].join("\n");

  const content = (input.contentBody ?? "").slice(0, MAX_CONTENT_CHARS);
  const parts = [
    `资产类型：${input.kind}`,
    `名称：${input.displayName}`,
    `来源仓库：${input.repoOwner && input.repoName ? `${input.repoOwner}/${input.repoName}` : "未提供"}`,
    `许可证：${input.license ?? "未声明"}`,
  ];

  if (input.description && input.description.trim().length > 0) {
    parts.push(`作者自述：${input.description.trim()}`);
  }

  if (content.length > 0) {
    parts.push(`正文：\n${content}`);
  } else {
    parts.push("正文：（未提供正文，仅依据上面的元信息撰写）");
  }

  return { system, user: parts.join("\n") };
}

/**
 * 从模型回复里解析出结构化初稿。
 *
 * 解析不出来（不是 JSON、缺字段、字段类型不对）一律返回 null ——
 * 由调用方降级成模板初稿。
 */
export function parseSummaryDraft(raw: string): Omit<SummaryDraft, "source"> | null {
  const text = raw.trim();
  if (text.length === 0) {
    return null;
  }

  // 模型偶尔会给 JSON 套一层 ```json 代码块，这里剥掉。
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;

  const summaryZh = typeof record.summaryZh === "string" ? record.summaryZh.trim() : "";
  if (summaryZh.length === 0) {
    return null;
  }

  const whenToUse = typeof record.whenToUse === "string" ? record.whenToUse.trim() : null;
  const howToUse = typeof record.howToUse === "string" ? record.howToUse.trim() : null;
  const tags = Array.isArray(record.tags)
    ? record.tags.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0)
    : [];

  return {
    summaryZh,
    whenToUse: whenToUse && whenToUse.length > 0 ? whenToUse : null,
    howToUse: howToUse && howToUse.length > 0 ? howToUse : null,
    tags: tags.slice(0, 8),
  };
}

/** DeepSeek 版生成器。 */
export class DeepSeekSummaryGenerator implements SummaryGenerator {
  private readonly apiKey: string | null;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DeepSeekSummaryGeneratorOptions = {}) {
    this.apiKey = options.apiKey === undefined ? envString("DEEPSEEK_API_KEY") : options.apiKey;
    this.baseUrl = (options.baseUrl ?? envString("DEEPSEEK_BASE_URL") ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      "",
    );
    this.model = options.model ?? envString("DEEPSEEK_MODEL") ?? DEFAULT_MODEL;
    this.timeoutMs = options.timeoutMs ?? envInt("DEEPSEEK_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** 生成简介初稿。**永不抛错** —— 失败一律降级成模板初稿。 */
  async generate(input: SummaryGeneratorInput): Promise<SummaryDraft> {
    if (!this.apiKey) {
      // 没配凭据 → 直接降级，不去白跑一趟网络。
      return templateSummaryDraft(input);
    }

    try {
      const raw = await this.callApi(input);
      const parsed = parseSummaryDraft(raw);
      if (!parsed) {
        return templateSummaryDraft(input);
      }
      return { ...parsed, source: "LLM" };
    } catch {
      // 网络挂了 / 超时 / 返回异常 —— 降级，不阻断发布。
      return templateSummaryDraft(input);
    }
  }

  /** 调一次 chat/completions，返回模型回复文本。 */
  private async callApi(input: SummaryGeneratorInput): Promise<string> {
    const { system, user } = buildSummaryPrompt(input);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.2,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`DeepSeek 返回 ${response.status}`);
      }

      const payload = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.trim().length === 0) {
        throw new Error("DeepSeek 返回内容为空");
      }
      return content;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * 默认生成器：配了 DEEPSEEK_API_KEY 就走 DeepSeek，否则走模板。
 *
 * 没配凭据时**不报错** —— 只是简介初稿退回模板文案（spec 决策 7 的降级路径）。
 */
export function createDefaultSummaryGenerator(): SummaryGenerator {
  return new DeepSeekSummaryGenerator();
}
