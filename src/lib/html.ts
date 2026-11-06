/**
 * 评论正文的 HTML 消毒。
 *
 * 评论正文是**用户输入**，直接拼进 HTML 就是 XSS。这里用最朴素也最稳的
 * 办法：把 5 个 HTML 元字符转成实体。手法沿用 DL-monitor 通知层的
 * `escapeHtml`（单趟正则替换，替换结果不会被二次扫描，
 * 所以 `&` → `&amp;` 不会被再转成 `&amp;amp;`）。
 *
 * 转义之后正文里不可能再出现 `<` `>` `"` `'`，于是「把正文当 HTML 渲染」
 * 与「把正文当纯文本渲染」**都**安全 —— 页面因此可以用
 * `dangerouslySetInnerHTML` 保住换行，而不用在每个组件里各写一遍判断。
 *
 * ⚠️ 落库的 `Comment.body` 是**原文**（运营要看到用户到底写了什么）；
 *    消毒发生在读路径上，页面与 API 拿到的都是消毒后的正文。
 */
const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#039;",
};

/** HTML 元字符 → 实体。 */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (match) => HTML_ESCAPES[match]);
}

/**
 * 控制字符与零宽字符。
 *
 * 这些字符肉眼看不见，却能破坏排版，也可能被用来夹带指令。
 * 保留的只有 `\n`（换行）与 `\t`（制表）。
 */
const INVISIBLE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200D\uFEFF]/g;

/**
 * 评论正文的消毒：归一化换行 → 去掉不可见字符 → 转义 HTML → 裁掉首尾空白。
 *
 * 返回的是**可以直接当 HTML 渲染**的纯文本。
 */
export function sanitizeCommentBody(raw: string): string {
  const normalized = raw.replace(/\r\n?/g, "\n").replace(INVISIBLE_CHARS, "");
  return escapeHtml(normalized).trim();
}
