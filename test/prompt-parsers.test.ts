/**
 * Prompt 解析器的纯函数单元测试（票 #15）。
 *
 * 覆盖三种格式（CSV / JSON / Markdown）与两条硬要求：
 *   1. **结构变更必须显式失败**（抛 SourceStructureError），不能静默返回空；
 *   2. **正文逐字** —— 解析出来的正文必须能在来源原文里逐字找到。
 *
 * 这些是纯函数测试：不碰数据库、不发网络请求。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SourceStructureError } from "@/collector/errors";
import {
  extractFencedBlocks,
  headingBefore,
  parseCsvRecords,
  parseJson,
} from "@/collector/prompt-parse";
import {
  PROMPT_SOURCES,
  findPromptSource,
  type PromptSourceDefinition,
} from "@/collector/prompt-sources";

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "prompt-repo",
);

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), "utf8");
}

/** 跑某个源的解析器。 */
function parseWith(
  sourceId: string,
  filePath: string,
  content: string,
): ReturnType<PromptSourceDefinition["parse"]> {
  const source = findPromptSource(sourceId);
  if (!source) {
    throw new Error(`未知的源：${sourceId}`);
  }
  return source.parse(filePath, content);
}

describe("CSV 解析器（RFC 4180）", () => {
  const csv = fixture("prompts-chat.csv");

  it("按记录解析，不受字段内换行影响", () => {
    const records = parseCsvRecords(csv);

    // 6 条记录（1 表头 + 5 数据）。
    expect(records).toHaveLength(6);
    expect(records[0]?.fields).toEqual([
      "act",
      "prompt",
      "for_devs",
      "type",
      "contributor",
    ]);
    expect(records[1]?.fields[0]).toBe("Ethereum Developer");
  });

  it("字段内的换行是数据，不会把记录切开", () => {
    const records = parseCsvRecords(csv);
    const interviewer = records.find((record) => record.fields[0] === "Job Interviewer");

    expect(interviewer).toBeDefined();
    // 字段里有两个裸 LF（\n\n 分段）。
    expect(interviewer?.fields[1]).toContain("\n\n");
    expect(interviewer?.fields[1]).toContain('My first sentence is "Hi"');
    // 引号被正确还原成单个字面量引号。
    expect(interviewer?.fields[1]).not.toContain('""');
  });

  it("CRLF 记录分隔符与裸 LF 字段换行都能处理", () => {
    const source = fixture("prompts-chat.csv");
    // fixture 里记录之间是 CRLF、字段内是裸 LF。
    expect(source).toContain("\r\n");
    expect(source.replace(/\r\n/g, "")).toContain("\n");

    // 把记录分隔符统一改成 LF 再解析，结果必须完全一样。
    const lfOnly = source.replace(/\r\n/g, "\n");
    const a = parseCsvRecords(source).map((record) => record.fields);
    const b = parseCsvRecords(lfOnly).map((record) => record.fields);
    expect(b).toEqual(a);
  });

  it("UTF-8 BOM 被剥掉，不会污染第一个字段名", () => {
    const withBom = `\uFEFF${fixture("prompts-chat.csv")}`;
    const records = parseCsvRecords(withBom);
    expect(records[0]?.fields[0]).toBe("act");
  });
});

describe("Markdown 围栏块解析", () => {
  it("正文逐字：能在原文里原样找到", () => {
    const markdown = fixture("youmind-readme.md");
    const blocks = extractFencedBlocks(markdown);

    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(markdown.slice(block.start, block.end)).toContain(block.body);
      expect(block.body.length).toBeGreaterThan(0);
    }
  });

  it("正文不 trim：保留末尾换行", () => {
    const markdown = "```\nhello\n```";
    const blocks = extractFencedBlocks(markdown);
    expect(blocks[0]?.body).toBe("hello\n");
  });

  it("闭围栏前的缩进代码块不会被误判成围栏", () => {
    const markdown = ["```", "    indented code", "    ```", "still inside", "```", "after"].join(
      "\n",
    );
    const blocks = extractFencedBlocks(markdown);
    // 只认第一个围栏（闭围栏要求顶格或至多 3 个空格缩进）。
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.body).toContain("still inside");
  });

  it("标题查找能按层级排除段落标题", () => {
    const markdown = [
      "### No. 1: 真正的标题",
      "",
      "#### 📖 Description",
      "",
      "描述正文",
      "",
      "#### 📝 Prompt",
    ].join("\n");
    const at = markdown.indexOf("#### 📝 Prompt");

    expect(headingBefore(markdown, at, { maxLevel: 3 })).toBe("No. 1: 真正的标题");
    // 不限层级时，会拿到更近的段落标题。
    expect(headingBefore(markdown, at)).toBe("📖 Description");
  });

  it("粗体小标题也能当标题（musegen 的形态）", () => {
    const markdown = ["## Moods", "", "**Nostalgic**", "", "```", "x", "```"].join("\n");
    const at = markdown.indexOf("```");
    expect(headingBefore(markdown, at)).toBe("Nostalgic");
  });
});

describe("JSON 解析", () => {
  it("解析失败时抛 SourceStructureError，不静默返回空", () => {
    expect(() => parseJson("{ 不是 json", "test")).toThrow(SourceStructureError);
  });

  it("顶层不是数组时抛 SourceStructureError", () => {
    const source = "CHENJIAMIAN/awesome-chatgpt-prompts-zh-CN";
    expect(() =>
      parseWith(source, "chatgpt_prompts-zh-CN.json", JSON.stringify({ entries: [] })),
    ).toThrow(SourceStructureError);
  });
});

describe("各语料源的解析器", () => {
  it("f/prompts.chat：表头变了要显式失败", () => {
    const csv = fixture("prompts-chat.csv");
    const broken = csv.replace("act,prompt,for_devs,type,contributor", "act,prompt,type");
    expect(() => parseWith("f/prompts.chat", "prompts.csv", broken)).toThrow(SourceStructureError);
  });

  it("f/prompts.chat：type 映射到模态（IMAGE → IMAGE，其余 → TEXT）", () => {
    const parsed = parseWith("f/prompts.chat", "prompts.csv", fixture("prompts-chat.csv"));
    const byAct = new Map(parsed.map((item) => [item.title, item]));

    expect(byAct.get("Cinematic still")?.modality).toBe("IMAGE");
    expect(byAct.get("Ethereum Developer")?.modality).toBe("TEXT");
    // STRUCTURED 本质还是文本。
    expect(byAct.get("Structured output")?.modality).toBe("TEXT");
  });

  it("f/prompts.chat：正文逐字 —— 与重新解析出来的字段完全一致", () => {
    const csv = fixture("prompts-chat.csv");
    const parsed = parseWith("f/prompts.chat", "prompts.csv", csv);

    // ⚠️ CSV 的「逐字」口径：**解码后的字段值**必须与来源重新解析的结果完全相等。
    //    它**不是**原始文件里的字面子串 —— 因为 CSV 里引号写成 `""` 转义、
    //    字段里含换行时还要被引号包起来。
    //    「不 trim / 不规范化」这条要求正是靠这个逐字相等来保证的。
    const records = parseCsvRecords(csv).slice(1);
    expect(parsed).toHaveLength(records.length);
    parsed.forEach((item, index) => {
      expect(item.body).toBe(records[index]?.fields[1]);
    });

    // 含内嵌换行的那条：换行与引号都原样保留。
    const interviewer = parsed.find((item) => item.title === "Job Interviewer");
    expect(interviewer?.body).toContain("\n\n");
    expect(interviewer?.body).toContain('"Hi"');
    expect(interviewer?.body).not.toContain('""Hi""');
  });

  it("YouMind：以「📝 Prompt」标记为锚点，一条不漏", () => {
    const markdown = fixture("youmind-readme.md");
    const parsed = parseWith(
      "YouMind-OpenLab/awesome-seedance-2-prompts",
      "README.md",
      markdown,
    );

    // 标记数 = 解析出的条数。
    const markers = markdown.split("#### 📝 Prompt").length - 1;
    expect(parsed).toHaveLength(markers);
    expect(parsed.length).toBeGreaterThanOrEqual(2);

    for (const item of parsed) {
      expect(markdown).toContain(item.body);
    }
  });

  it("ZeroLu：跳过 bash / python 示例块", () => {
    const parsed = parseWith(
      "ZeroLu/awesome-seedance",
      "README.md",
      fixture("zerolu-readme.md"),
    );

    expect(parsed.length).toBeGreaterThan(0);
    for (const item of parsed) {
      expect(item.body).not.toMatch(/^curl /m);
      expect(item.body).not.toMatch(/^import /m);
    }
  });

  it("bytedance：索引文件（没有 data）跳过，不算结构变更", () => {
    const parsed = parseWith(
      "bytedance/Video-As-Prompt",
      "examples/training/sft/cogvideox/vap_mot/validation.json",
      JSON.stringify({ root: "data/Video-As-Prompt", val_data: ["vap_data.csv"] }),
    );
    expect(parsed).toEqual([]);
  });

  it("bytedance：caption 就是正文，逐字", () => {
    const content = fixture("video-as-prompt-validation.json");
    const parsed = parseWith(
      "bytedance/Video-As-Prompt",
      "examples/training/sft/cogvideox/crush_smol_lora/validation.json",
      content,
    );

    // 3 条里 1 条 caption 是空串 → 跳过。
    expect(parsed).toHaveLength(2);
    for (const item of parsed) {
      expect(content).toContain(item.body);
      expect(item.modality).toBe("VIDEO");
      expect(item.toolTags).toContain("cogvideox");
    }
  });

  it("Anil-matcha flux3：只取 Prompt Library 段，且按 Best for 判模态", () => {
    const content = fixture("flux3-readme.md");
    const parsed = parseWith(
      "Anil-matcha/awesome-flux-3-api-prompts",
      "README.md",
      content,
    );

    expect(parsed.length).toBeGreaterThanOrEqual(3);
    // README 里的 bash 示例块不能被当成 prompt。
    for (const item of parsed) {
      expect(item.body).not.toContain("curl -X POST");
    }

    const video = parsed.find((item) => item.modality === "VIDEO");
    expect(video).toBeDefined();
    expect(parsed.filter((item) => item.modality === "IMAGE").length).toBeGreaterThan(0);
  });

  it("suno-style-recipes：style_prompt 含逗号也能正确解析", () => {
    const content = fixture("suno-style-recipes.csv");
    const parsed = parseWith(
      "samuelgrupolimex-prog/suno-style-recipes",
      "styles.csv",
      content,
    );

    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.title).toBe("90s R&B Revival");
    // 逗号没有被切错列。
    expect(parsed[0]?.body).toContain("new jack swing groove");
    expect(content).toContain(parsed[0]?.body as string);
  });

  it("中文语料：act / prompt 逐字", () => {
    const content = fixture("chatgpt-prompts-zh-cn.json");
    const parsed = parseWith(
      "CHENJIAMIAN/awesome-chatgpt-prompts-zh-CN",
      "chatgpt_prompts-zh-CN.json",
      content,
    );

    expect(parsed).toHaveLength(2);
    for (const item of parsed) {
      expect(content).toContain(item.body);
    }
  });

  it("音乐源：围栏块逐字，且标题能取到", () => {
    const content = fixture("awesome-suno-prompts-pop.md");
    const parsed = parseWith(
      "naqashmunir21/awesome-suno-prompts",
      "prompts/pop.md",
      content,
    );

    expect(parsed.length).toBeGreaterThan(0);
    for (const item of parsed) {
      expect(content).toContain(item.body);
      expect(item.title).toBeTruthy();
    }
  });

  it("musegen：`##` 与粗体小标题两种形态都能收", () => {
    const content = fixture("musegen-genres.md");
    const parsed = parseWith(
      "musegen/awesome-music-prompts",
      "prompts/genres.md",
      content,
    );

    expect(parsed.length).toBeGreaterThanOrEqual(2);
    const titles = parsed.map((item) => item.title);
    expect(titles).toContain("Pop — Radio Anthem");
    expect(titles).toContain("Nostalgic");
  });
});

describe("语料源目录本身", () => {
  it("每个源都声明了模态、工具标签与至少一个路径", () => {
    for (const source of PROMPT_SOURCES) {
      expect(source.modality).toBeTruthy();
      expect(source.toolTags.length).toBeGreaterThan(0);
      expect(source.paths.length).toBeGreaterThan(0);
      expect(source.owner).toBeTruthy();
      expect(source.repo).toBeTruthy();
    }
  });

  it("源 id 唯一", () => {
    const ids = PROMPT_SOURCES.map((source) => source.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("四种模态都有源覆盖", () => {
    const modalities = new Set(PROMPT_SOURCES.map((source) => source.modality));
    expect(modalities).toContain("TEXT");
    expect(modalities).toContain("IMAGE");
    expect(modalities).toContain("VIDEO");
    expect(modalities).toContain("MUSIC");
  });
});
