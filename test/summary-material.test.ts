/**
 * 摘要素材提取（票 #26）。
 *
 * ## 这个文件解决什么
 *
 * 站上 10334 条资产的「何时用 / 怎么用」全为空。根因不是「没跑重跑」，
 * 而是摘要生成器**只从 `skillDetail.frontmatter` 取作者自述** ——
 * PROMPT / MCP 根本不走那张表，素材压根没进生成器。
 *
 * 这里把「按资产类型取素材」抽成一个纯函数：模板路线与 LLM 路线共用同一份
 * 素材，行为一致、可单测，不碰数据库。
 *
 * ## 为什么 PROMPT 不取 act
 *
 * 实测 6348 条 PROMPT 的 `act` **全部等于 `displayName`**（同义反复，零信息量）。
 * 真正有信息量的是 `modality`（TEXT / MUSIC / VIDEO / IMAGE）与 `toolTags`
 * （suno / seedance / chatgpt …）—— 它们才回答得了「什么时候该用它」。
 */
import { describe, expect, it } from "vitest";

import { extractSummaryMaterial } from "@/lib/summary-material";

describe("按资产类型取素材", () => {
  it("SKILL：取 frontmatter 里的 description 作作者自述", () => {
    const material = extractSummaryMaterial({
      kind: "SKILL",
      skillDetail: {
        frontmatter: { name: "pdf-skill", description: "批量把 PDF 转成 Markdown。" },
      },
    });

    expect(material.authorNote).toBe("批量把 PDF 转成 Markdown。");
    expect(material.modality).toBeNull();
    expect(material.toolTags).toEqual([]);
  });

  it("SKILL：frontmatter 里没有 description → 没有作者自述", () => {
    const material = extractSummaryMaterial({
      kind: "SKILL",
      skillDetail: { frontmatter: { name: "pdf-skill" } },
    });

    expect(material.authorNote).toBeNull();
  });

  it("SKILL：frontmatter 不是对象（数组 / 字符串 / null）→ 没有作者自述，也不抛错", () => {
    expect(
      extractSummaryMaterial({ kind: "SKILL", skillDetail: { frontmatter: ["a"] } }).authorNote,
    ).toBeNull();
    expect(
      extractSummaryMaterial({ kind: "SKILL", skillDetail: { frontmatter: "不是对象" } })
        .authorNote,
    ).toBeNull();
    expect(
      extractSummaryMaterial({ kind: "SKILL", skillDetail: { frontmatter: null } }).authorNote,
    ).toBeNull();
  });

  it("PROMPT：act 与标题同义反复，不作作者自述；带出 modality 与 toolTags", () => {
    const material = extractSummaryMaterial({
      kind: "PROMPT",
      promptDetail: {
        act: "Instrumental Companion (Same Arrangement)",
        modality: "MUSIC",
        toolTags: ["suno"],
      },
    });

    expect(material.authorNote).toBeNull();
    expect(material.modality).toBe("MUSIC");
    expect(material.toolTags).toEqual(["suno"]);
  });

  it("PROMPT：toolTags 为空 → 空数组", () => {
    const material = extractSummaryMaterial({
      kind: "PROMPT",
      promptDetail: { act: "标题", modality: "TEXT", toolTags: [] },
    });

    expect(material.toolTags).toEqual([]);
    expect(material.modality).toBe("TEXT");
  });

  it("MCP：取 serverDescription 作作者自述", () => {
    const material = extractSummaryMaterial({
      kind: "MCP",
      mcpDetail: { serverDescription: "查询 GitHub 仓库信息。" },
    });

    expect(material.authorNote).toBe("查询 GitHub 仓库信息。");
  });

  it("SCENARIO：不取素材 —— 卡片的「何时用」归派生逻辑管", () => {
    const material = extractSummaryMaterial({
      kind: "SCENARIO",
      scenarioDetail: { scenarioText: "user wants to review a branch" },
    });

    expect(material.authorNote).toBeNull();
  });

  it("空白字符串当作没有素材", () => {
    expect(
      extractSummaryMaterial({ kind: "MCP", mcpDetail: { serverDescription: "   " } }).authorNote,
    ).toBeNull();
  });
});
