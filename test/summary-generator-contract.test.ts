/**
 * 真实 DeepSeek 的**契约测试**（spec 的 port 约定：默认跳过）。
 *
 * 验的是「真实 API 的响应结构」与「真实降级路径」——
 * 假实现验不了这两件事：模型可能返回带代码块的 JSON、可能返回意料之外的结构、
 * 可能直接拒绝一个坏 key。
 *
 * 默认**跳过**：跑它需要真实的 DEEPSEEK_API_KEY，会花钱、也会依赖网络。
 * 要跑的时候显式打开：
 *
 *     $env:RUN_LLM_CONTRACT = "1"; pnpm vitest run test/summary-generator-contract.test.ts
 *
 * ⚠️ 密钥只从环境变量读 —— 绝不写进代码、绝不提交进仓库。
 */
import { describe, expect, it } from "vitest";

import { DeepSeekSummaryGenerator } from "@/lib/deepseek-summary-generator";
import type { SummaryGeneratorInput } from "@/lib/summary-generator";

const ENABLED = process.env.RUN_LLM_CONTRACT === "1";
const API_KEY = process.env.DEEPSEEK_API_KEY ?? null;

const INPUT: SummaryGeneratorInput = {
  kind: "SKILL",
  displayName: "PDF 批处理",
  contentBody: [
    "# PDF 批处理",
    "",
    "把一个目录里的 PDF 批量转成 Markdown。",
    "用法：运行 `python convert.py <目录>`。",
  ].join("\n"),
  description: "批量把 PDF 转成 Markdown。",
  repoOwner: "example",
  repoName: "pdf-batch",
  license: "mit",
};

describe.skipIf(!ENABLED || !API_KEY)("DeepSeek 契约测试（需要真实 API key）", () => {
  it("返回结构化的中文简介初稿：何时用 / 怎么用 / 标签", async () => {
    const generator = new DeepSeekSummaryGenerator({ apiKey: API_KEY });

    const draft = await generator.generate(INPUT);

    expect(draft.source).toBe("LLM");
    expect(draft.summaryZh.length).toBeGreaterThan(0);
    expect(draft.summaryZh).toContain("PDF");
    expect(draft.whenToUse).toBeTruthy();
    expect(draft.howToUse).toBeTruthy();
    expect(Array.isArray(draft.tags)).toBe(true);
  }, 60_000);

  it("真实降级路径：凭据无效时不抛错，改为模板初稿", async () => {
    const generator = new DeepSeekSummaryGenerator({ apiKey: "not-a-real-key" });

    const draft = await generator.generate(INPUT);

    expect(draft.source).toBe("TEMPLATE");
    expect(draft.summaryZh.length).toBeGreaterThan(0);
  }, 60_000);
});
