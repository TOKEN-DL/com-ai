/**
 * 按资产类型分派的模板初稿（票 #26 切片 2）。
 *
 * ## 为什么 PROMPT 需要单独一条路
 *
 * 站上 6348 条 PROMPT 的素材与 Skill 完全不同：
 *
 * - Skill 有作者自述（frontmatter.description），「适用于：{自述}」就够；
 * - Prompt 的 `act` 恒等于标题（零信息量），真正能回答「什么时候该用它」的是
 *   **模态**（音乐 / 视频 / 图片 / 文本）与**目标工具**（Suno / Seedance / ChatGPT …）。
 *
 * 所以 PROMPT 的「何时用」按模态组句、带上自己的标题与目标工具 ——
 * 不是把一个模板句套 6348 遍。
 *
 * ## 不变的约定
 *
 * - 模板路径的来源标记恒为 `TEMPLATE`（页面显示「模板生成」，不谎称 AI 生成）；
 * - 模板文案**不复制正文**（正文只给 LLM 看）。
 */
import { describe, expect, it } from "vitest";

import { templateSummaryDraft, type SummaryGeneratorInput } from "@/lib/summary-generator";

const BODY = "Upbeat 80s-influenced synth-pop anthem, driving four-on-the-floor drums.";

function promptInput(overrides: Partial<SummaryGeneratorInput> = {}): SummaryGeneratorInput {
  return {
    kind: "PROMPT",
    displayName: "Instrumental Companion (Same Arrangement)",
    contentBody: BODY,
    description: null,
    repoOwner: "CHENJIAMIAN",
    repoName: "awesome-chatgpt-prompts-zh-CN",
    license: "cc0-1.0",
    modality: "MUSIC",
    toolTags: ["suno"],
    ...overrides,
  };
}

describe("PROMPT 的模板初稿", () => {
  it("音乐 + Suno：何时用说清是拿什么工具生成什么风格的音乐", () => {
    const draft = templateSummaryDraft(promptInput());

    expect(draft.source).toBe("TEMPLATE");
    expect(draft.whenToUse).toBe(
      "当你需要用 Suno 生成一段「Instrumental Companion (Same Arrangement)」风格的音乐时。",
    );
  });

  it("文本 + ChatGPT：何时用说清是完成哪一类任务", () => {
    const draft = templateSummaryDraft(
      promptInput({
        displayName: "Chase a Late Payment: 3 Reminders, Friendly to Final",
        modality: "TEXT",
        toolTags: ["chatgpt"],
      }),
    );

    expect(draft.whenToUse).toBe(
      "当你需要用 ChatGPT 完成「Chase a Late Payment: 3 Reminders, Friendly to Final」这类任务时。",
    );
  });

  it("视频 + Seedance：何时用说清是生成一段视频", () => {
    const draft = templateSummaryDraft(
      promptInput({ displayName: "雨夜霓虹街道", modality: "VIDEO", toolTags: ["seedance"] }),
    );

    expect(draft.whenToUse).toBe("当你需要用 Seedance 生成一段「雨夜霓虹街道」风格的视频时。");
  });

  it("图片 + CogView 4：何时用说清是生成一张图片", () => {
    const draft = templateSummaryDraft(
      promptInput({ displayName: "水彩风格的山间小屋", modality: "IMAGE", toolTags: ["cogview4"] }),
    );

    expect(draft.whenToUse).toBe(
      "当你需要用 CogView 4 生成一张「水彩风格的山间小屋」风格的图片时。",
    );
  });

  it("怎么用：说清在详情页复制正文、粘到哪个工具里", () => {
    const draft = templateSummaryDraft(promptInput());

    expect(draft.howToUse).toBe("在详情页复制提示词正文，粘贴到 Suno 里直接使用。");
  });

  it("简介说清模态与目标工具", () => {
    const draft = templateSummaryDraft(promptInput());

    expect(draft.summaryZh).toContain("Instrumental Companion (Same Arrangement)");
    expect(draft.summaryZh).toContain("音乐");
    expect(draft.summaryZh).toContain("Suno");
  });

  it("模板文案不复制正文", () => {
    const draft = templateSummaryDraft(promptInput());

    expect(draft.summaryZh).not.toContain("four-on-the-floor");
    expect(draft.whenToUse).not.toContain("four-on-the-floor");
    expect(draft.howToUse).not.toContain("four-on-the-floor");
  });

  it("没有目标工具：退化成通用提示词，但「何时用」仍非空", () => {
    const draft = templateSummaryDraft(promptInput({ toolTags: [] }));

    expect(draft.whenToUse).toBe("当你需要一份音乐类提示词时。");
    expect(draft.howToUse).toBe("在详情页复制提示词正文后直接使用。");
    expect(draft.summaryZh).toContain("通用提示词");
  });

  it("没有模态也没有工具：只说是一份提示词", () => {
    const draft = templateSummaryDraft(promptInput({ modality: null, toolTags: [] }));

    expect(draft.whenToUse).toBe("当你需要一份提示词时。");
  });

  it("不认识的工具标签原样输出，不编造名字", () => {
    const draft = templateSummaryDraft(promptInput({ toolTags: ["some-new-tool"] }));

    expect(draft.whenToUse).toContain("some-new-tool");
  });

  it("作者自己写过的话优先于模态组句 —— 用户发布的资产走这条路", () => {
    const draft = templateSummaryDraft(
      promptInput({ description: "催款邮件的三段提醒话术，语气友好但不软弱。" }),
    );

    expect(draft.whenToUse).toBe("适用于：催款邮件的三段提醒话术，语气友好但不软弱。");
    expect(draft.summaryZh).toContain("催款邮件的三段提醒话术，语气友好但不软弱。");
  });

  it("多个目标工具都列出来", () => {
    const draft = templateSummaryDraft(promptInput({ toolTags: ["suno", "udio"] }));

    expect(draft.whenToUse).toBe(
      "当你需要用 Suno、Udio 生成一段「Instrumental Companion (Same Arrangement)」风格的音乐时。",
    );
  });
});
