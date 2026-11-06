/**
 * 发布内容的自动关键词过滤（纯函数，不构成 seam —— 但它是审核链路的第一道关口，
 * 得有测试盯着）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { filterPublishText } from "@/lib/publish-keyword-filter";

const ENV_KEY = "PUBLISH_BLOCKED_KEYWORDS";
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});

afterEach(() => {
  if (saved === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = saved;
  }
});

describe("关键词过滤", () => {
  it("正常内容不命中", () => {
    const result = filterPublishText("批量把 PDF 转成 Markdown 的 Skill。");
    expect(result.hit).toBe(false);
    expect(result.reason).toBeNull();
  });

  it("命中引流类关键词：给出原因与命中的词", () => {
    const result = filterPublishText("加微信领取福利");
    expect(result.hit).toBe(true);
    expect(result.matched).toContain("加微信");
    expect(result.reason).toContain("引流");
  });

  it("大小写不影响命中", () => {
    expect(filterPublishText("free CASINO money").hit).toBe(true);
  });

  it("空文本不命中", () => {
    expect(filterPublishText("").hit).toBe(false);
    expect(filterPublishText("   ").hit).toBe(false);
  });

  it("环境变量可以追加关键词", () => {
    process.env[ENV_KEY] = "违禁词一,违禁词二";
    const result = filterPublishText("这里有违禁词二");
    expect(result.hit).toBe(true);
    expect(result.matched).toContain("违禁词二");
  });
});
