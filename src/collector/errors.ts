/**
 * 采集层的错误类型。
 *
 * 分三类，因为**处理方式不同**：
 *   - `SourceStructureError` —— 上游结构变了（字段改名、数组变对象…）。
 *     必须显式失败，不能降级成「采到 0 条」。
 *   - `SourceConfigError` —— 调用方给的源配置不合法。不该发请求。
 *   - 网络 / HTTP 错误见 `src/collector/http.ts` 的 `HttpError`。
 */

/** 上游返回的结构与预期不符。抛这个错 = 「上游改版了，需要人看」。 */
export class SourceStructureError extends Error {
  readonly source: string;

  constructor(source: string, detail: string) {
    super(`[${source}] 采集源结构与预期不符：${detail}`);
    this.name = "SourceStructureError";
    this.source = source;
  }
}

/** 源配置不合法。 */
export class SourceConfigError extends Error {
  readonly source: string;

  constructor(source: string, detail: string) {
    super(`[${source}] 采集源配置不合法：${detail}`);
    this.name = "SourceConfigError";
    this.source = source;
  }
}

/** frontmatter 不是合法 YAML。 */
export class FrontmatterParseError extends Error {
  constructor(detail: string) {
    super(`SKILL.md 的 frontmatter 解析失败：${detail}`);
    this.name = "FrontmatterParseError";
  }
}
