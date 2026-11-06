/**
 * 评论正文的 HTML 消毒（票 #10 的硬性要求：用户输入直接渲染就是 XSS）。
 *
 * 纯函数单元测试。它守的是「正文里不可能再出现可执行标记」这条不变量 ——
 * 页面与 API 都靠它，所以它一旦破了，XSS 就回来了。
 */
import { describe, expect, it } from "vitest";

import { escapeHtml, sanitizeCommentBody } from "@/lib/html";

describe("escapeHtml", () => {
  it("转义 5 个 HTML 元字符", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#039;");
  });

  it("单趟替换：& 不会被二次转义", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });
});

describe("sanitizeCommentBody", () => {
  it("脚本标签不会变成可执行标记", () => {
    expect(sanitizeCommentBody("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  it("事件属性里的引号被转义，属性注入无效", () => {
    const result = sanitizeCommentBody(`<img src=x onerror="alert(1)">`);
    expect(result).not.toContain("<");
    expect(result).not.toContain(">");
    expect(result).toContain("&quot;");
  });

  it("消毒后不可能残留裸的尖括号", () => {
    const nasty = `<a href="javascript:alert(1)">点我</a>`;
    const result = sanitizeCommentBody(nasty);
    expect(result.includes("<")).toBe(false);
    expect(result.includes(">")).toBe(false);
  });

  it("正常文本原样保留", () => {
    expect(sanitizeCommentBody("这个 Skill 很好用")).toBe("这个 Skill 很好用");
  });

  it("换行被统一成 \\n，不吞掉段落", () => {
    expect(sanitizeCommentBody("第一行\r\n第二行")).toBe("第一行\n第二行");
  });

  it("控制字符与零宽字符被去掉", () => {
    expect(sanitizeCommentBody("正常\u0000\u200B内容")).toBe("正常内容");
  });

  it("首尾空白被裁掉", () => {
    expect(sanitizeCommentBody("  内容  ")).toBe("内容");
  });
});
