/**
 * 评论的自动关键词过滤（票 #10 验收标准第 3 条）。
 *
 * 这是**纯函数单元测试**，不构成 seam（spec 的「Testing Decisions」把纯函数
 * 单测与两个 seam 分开列）。它守的是审核链路的第一环：
 * 命中过滤词的评论必须被拦下来。
 */
import { describe, expect, it } from "vitest";

import {
  BLOCKED_KEYWORDS,
  findBlockedKeyword,
  findBlockedKeywords,
  isBlocked,
  normalizeForFilter,
} from "@/lib/content-filter";

describe("关键词过滤：命中即拦截", () => {
  it("命中引流类话术", () => {
    expect(isBlocked("需要资料的话加微信详聊")).toBe(true);
  });

  it("命中代开发票类话术", () => {
    expect(isBlocked("低价代开发票，量大从优")).toBe(true);
  });

  it("命中兼职刷单类话术", () => {
    expect(isBlocked("在家兼职刷单，日赚三百")).toBe(true);
  });

  it("正常的技术讨论不命中", () => {
    expect(isBlocked("这个 Skill 处理 PDF 很好用，已经收藏了")).toBe(false);
    expect(isBlocked("请问 Docker compose 怎么配代理？")).toBe(false);
    expect(isBlocked("OAuth 扫码登录的回调怎么写？")).toBe(false);
  });
});

describe("关键词过滤：归一化", () => {
  it("全角字符按半角比较", () => {
    expect(normalizeForFilter("ＡＢＣ")).toBe("abc");
  });

  it("忽略大小写", () => {
    expect(isBlocked("加QQ 详聊")).toBe(true);
  });

  it("去掉空白，挡住「加 微 信」这类插空格的规避", () => {
    expect(isBlocked("加 微 信")).toBe(true);
    expect(normalizeForFilter("加 微 信")).toBe("加微信");
  });

  it("词表本身不含空白，两侧归一化后形态一致", () => {
    for (const word of BLOCKED_KEYWORDS) {
      expect(word).not.toMatch(/\s/);
    }
  });
});

describe("关键词过滤：命中的是哪个词", () => {
  it("报出第一个命中的词（运营抽查时要看）", () => {
    expect(findBlockedKeyword("先加微信，再代开发票")).toBe("加微信");
  });

  it("一次报出全部命中的词", () => {
    expect(findBlockedKeywords("先加微信，再代开发票")).toEqual(["加微信", "代开发票"]);
  });

  it("没命中时返回 null / 空数组", () => {
    expect(findBlockedKeyword("今天天气不错")).toBeNull();
    expect(findBlockedKeywords("今天天气不错")).toEqual([]);
  });
});
