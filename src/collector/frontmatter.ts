/**
 * SKILL.md 的 frontmatter 解析。
 *
 * 实测要点（见 .com-ai-context/verified-endpoints.md 第 1.2 / 3 节）：
 *   - `description` **可能是 YAML 块标量 `|-` 多行**，不能按 `split(": ")` 切；
 *     这里用 `yaml` 包解析（能正确处理块标量、折叠标量、嵌套结构）。
 *   - `license` 是**可选**字段（实测 `skill-creator` 的 frontmatter 只有 name + description）。
 *   - 稳定字段只有 `name` + `description`。
 *
 * 正文（body）从**原文**切出来，不做换行归一化 —— 站上要能复制出与上游逐字一致的
 * SKILL.md，所以原始字节必须原样保留。
 */
import { parse as parseYaml } from "yaml";

import { FrontmatterParseError } from "@/collector/errors";

export type Frontmatter = {
  /// 解析出的 frontmatter 字段（YAML 对象）。
  data: Record<string, unknown>;
  /// 去掉 frontmatter 之后的正文（保留原文换行）。
  body: string;
  /// 原文是否带 frontmatter。
  hasFrontmatter: boolean;
};

/**
 * frontmatter 分隔符。
 *
 * 开头必须是 `---` 独占一行；结束是下一个 `---` 独占一行。
 * 允许 CRLF。
 */
const FRONTMATTER_PATTERN = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * 解析 SKILL.md 的 frontmatter。
 *
 * 没有 frontmatter 时返回空 data + 原文 body（不算错误）。
 * frontmatter 不是合法 YAML 时抛 {@link FrontmatterParseError} —— 显式失败，
 * 不静默当成「没有 frontmatter」。
 */
export function parseFrontmatter(raw: string): Frontmatter {
  const match = FRONTMATTER_PATTERN.exec(raw);
  if (!match) {
    return { data: {}, body: raw, hasFrontmatter: false };
  }

  // 只把 frontmatter 块内部的换行归一化，正文保持原样。
  const block = match[1].replace(/\r\n/g, "\n");

  let parsed: unknown;
  try {
    parsed = parseYaml(block);
  } catch (error) {
    throw new FrontmatterParseError(error instanceof Error ? error.message : String(error));
  }

  const data =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};

  return { data, body: raw.slice(match[0].length), hasFrontmatter: true };
}

/** 取 frontmatter 里的字符串字段；不是字符串就当没有。 */
export function frontmatterString(
  data: Record<string, unknown>,
  key: string,
): string | null {
  const value = data[key];
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}
