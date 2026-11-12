/**
 * 场景短语的派生规则（票 #12 验收标准第 5 条的前半段：派生规则本身）。
 *
 * Seam 1 —— 纯函数单元测试：派生规则不碰数据库、不读环境变量，
 * 同样的输入永远得到同样的输出，所以这里直接把规则钉死。
 *
 * 盯三件事：
 *   1. **归一化**：大小写、全半角、空格、标点的差异都不该产生第二个场景；
 *   2. **抽取**：「何时用」子句优先，其余从自述里挑第一个站得住的片段；
 *   3. **去重**：同一个资产 + 同一个场景，只有一个结果。
 */
import { describe, expect, it } from "vitest";

import {
  deriveScenarios,
  extractScenarioPhrases,
  normalizeScenarioKey,
  splitSentences,
} from "@/lib/scenario-derivation";

describe("场景短语的归一化键", () => {
  it("大小写、全半角、空格、标点的差异都落到同一个键上", () => {
    const key = normalizeScenarioKey("批量处理 PDF，批量");

    expect(key).toBe(normalizeScenarioKey("　批量处理ＰＤＦ 批量"));
    expect(key).toBe(normalizeScenarioKey("批量处理pdf批量"));
    expect(key).toBe(normalizeScenarioKey("批量处理 PDF 批量"));
  });

  it("不同场景的键不一样", () => {
    expect(normalizeScenarioKey("批量处理 PDF")).not.toBe(normalizeScenarioKey("字幕转写"));
  });
});

describe("句子切分", () => {
  it("中文标点断句，英文句号要「句号 + 空白 + 大写」才断", () => {
    expect(splitSentences("第一句。第二句！第三句？")).toEqual(["第一句。", "第二句！", "第三句？"]);
    expect(splitSentences("First one. Second one.")).toEqual(["First one.", "Second one."]);
  });

  it("缩写后面的句号不是句末", () => {
    expect(splitSentences("Uses e.g. Skills for search.")).toEqual([
      "Uses e.g. Skills for search.",
    ]);
  });
});

describe("从文字里抽场景短语", () => {
  it("「何时用」子句优先：中文的「当……时」", () => {
    const phrases = extractScenarioPhrases("当需要批量处理 PDF 文件时使用。");

    expect(phrases[0]).toBe("需要批量处理 PDF 文件");
  });

  it("「何时用」子句优先：英文的 Use when …", () => {
    const phrases = extractScenarioPhrases("Use when writing a PR body.");

    expect(phrases[0]).toBe("writing a PR body");
  });

  it("没有「何时用」子句时，取自述里第一个站得住的片段", () => {
    const phrases = extractScenarioPhrases(
      "Read first to make, edit, animate or render any video with HyperFrames.",
    );

    // "make" / "edit" 这类列表项太短，不算场景；第一个站得住的是动作短语。
    expect(phrases[0]).toBe("animate or render any video");
  });

  it("后面的句子只有明确写了「何时用」才产出场景", () => {
    const withWhen = extractScenarioPhrases(
      "Build a deck for the team. Use when the person wants a slide outline.",
    );
    expect(withWhen).toContain("Build a deck for the team");
    expect(withWhen).toContain("person wants a slide outline");

    const withoutWhen = extractScenarioPhrases(
      "Build a deck for the team. It also keeps the fonts consistent.",
    );
    expect(withoutWhen).toEqual(["Build a deck for the team"]);
  });

  it("空文本抽不出场景", () => {
    expect(extractScenarioPhrases(null)).toEqual([]);
    expect(extractScenarioPhrases("   ")).toEqual([]);
  });
});

describe("从一个资产派生场景", () => {
  it("「何时用」优先于 frontmatter 自述", () => {
    const scenarios = deriveScenarios({
      whenToUse: "当需要批量处理 PDF 文件时使用。",
      frontmatter: { description: "Batch process PDF files." },
    });

    expect(scenarios).toHaveLength(1);
    expect(scenarios[0].origin).toBe("whenToUse");
    expect(scenarios[0].text).toBe("需要批量处理 PDF 文件");
  });

  it("没有「何时用」时退回 frontmatter 自述", () => {
    const scenarios = deriveScenarios({
      whenToUse: null,
      frontmatter: { description: "Use when transcribing subtitles from a video." },
    });

    expect(scenarios).toHaveLength(1);
    expect(scenarios[0].origin).toBe("frontmatter");
    expect(scenarios[0].text).toBe("transcribing subtitles from a video");
  });

  it("同一个资产 + 同一个场景只出现一次", () => {
    const scenarios = deriveScenarios({
      whenToUse: "当需要批量处理 PDF 文件时使用。",
      frontmatter: { description: "当需要批量处理 PDF 文件时使用。" },
    });

    expect(scenarios).toHaveLength(1);
    // 去重键是**场景短语**的归一化结果，不是整句。
    expect(scenarios[0].key).toBe(normalizeScenarioKey("需要批量处理 PDF 文件"));
  });

  it("frontmatter 里没有 description 时派生不出场景", () => {
    expect(deriveScenarios({ frontmatter: { name: "pdf" } })).toEqual([]);
    expect(deriveScenarios({ frontmatter: null })).toEqual([]);
    expect(deriveScenarios({})).toEqual([]);
  });
});
