/**
 * 中文简介生成端口（spec 决策 7）与其 DeepSeek 实现。
 *
 * 端口的行为是「**失败不抛错，降级成模板初稿**」——
 * 这一条既在实现里测，也在 HTTP 边界上测（test/publish.test.ts）。
 */
import { describe, expect, it } from "vitest";

import {
  DeepSeekSummaryGenerator,
  buildSummaryPrompt,
  parseSummaryDraft,
} from "@/lib/deepseek-summary-generator";
import {
  TemplateSummaryGenerator,
  setSummaryGenerator,
  templateSummaryDraft,
  type SummaryGeneratorInput,
} from "@/lib/summary-generator";

const INPUT: SummaryGeneratorInput = {
  kind: "SKILL",
  displayName: "我的 PDF Skill",
  contentBody: "# 我的 Skill\n\n把 PDF 转成 Markdown。",
  description: "批量把 PDF 转成 Markdown。",
  repoOwner: "example",
  repoName: "my-pdf-skill",
  license: "mit",
};

describe("模板降级初稿", () => {
  it("来源标记是 TEMPLATE，且不引用正文", () => {
    const draft = templateSummaryDraft(INPUT);

    expect(draft.source).toBe("TEMPLATE");
    expect(draft.summaryZh).toContain("example/my-pdf-skill");
    expect(draft.summaryZh).toContain("我的 PDF Skill");
    expect(draft.summaryZh).toContain("批量把 PDF 转成 Markdown。");
    // 模板文案不复制正文。
    expect(draft.summaryZh).not.toContain("# 我的 Skill");
  });

  it("没有用户简介时也能给出一段话", () => {
    const draft = templateSummaryDraft({ ...INPUT, description: null });
    expect(draft.summaryZh.length).toBeGreaterThan(0);
    expect(draft.whenToUse).toBeNull();
  });

  it("模板生成器永远返回 TEMPLATE 来源", async () => {
    const draft = await new TemplateSummaryGenerator().generate(INPUT);
    expect(draft.source).toBe("TEMPLATE");
  });
});

describe("提示词", () => {
  it("把正文与元信息都放进提示词，并要求输出 JSON", () => {
    const { system, user } = buildSummaryPrompt(INPUT);

    expect(system).toContain("JSON");
    expect(user).toContain("我的 PDF Skill");
    expect(user).toContain("example/my-pdf-skill");
    expect(user).toContain("mit");
    expect(user).toContain("把 PDF 转成 Markdown。");
  });

  it("没有正文时明说「未提供正文」", () => {
    const { user } = buildSummaryPrompt({ ...INPUT, contentBody: null });
    expect(user).toContain("未提供正文");
  });
});

describe("解析模型回复", () => {
  it("正常 JSON 能解析出来", () => {
    const parsed = parseSummaryDraft(
      JSON.stringify({
        summaryZh: "一个把 PDF 转 Markdown 的 Skill。",
        whenToUse: "批量处理 PDF 时。",
        howToUse: "装上后直接调用。",
        tags: ["文档处理", "PDF"],
      }),
    );

    expect(parsed?.summaryZh).toBe("把 PDF 转 Markdown 的 Skill。");
    expect(parsed?.whenToUse).toBe("批量处理 PDF 时。");
    expect(parsed?.tags).toEqual(["文档处理", "PDF"]);
  });

  it("模型套了 ```json 代码块也能解析", () => {
    const parsed = parseSummaryDraft(
      '```json\n{"summaryZh":"简介","whenToUse":"何时","howToUse":"怎么","tags":[]}\n```',
    );
    expect(parsed?.summaryZh).toBe("简介");
  });

  it("不是 JSON / 缺字段 → null（调用方据此降级）", () => {
    expect(parseSummaryDraft("这不是 JSON")).toBeNull();
    expect(parseSummaryDraft("")).toBeNull();
    expect(parseSummaryDraft(JSON.stringify({ whenToUse: "何时" }))).toBeNull();
    expect(parseSummaryDraft(JSON.stringify(["数组"]))).toBeNull();
  });
});

describe("DeepSeek 实现", () => {
  it("调用成功：来源标记是 LLM，内容是模型返回的", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const generator = new DeepSeekSummaryGenerator({
      apiKey: "test-key",
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    summaryZh: "AI 写的简介。",
                    whenToUse: "何时用",
                    howToUse: "怎么用",
                    tags: ["文档"],
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const draft = await generator.generate(INPUT);

    expect(draft.source).toBe("LLM");
    expect(draft.summaryZh).toBe("AI 写的简介。");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("chat/completions");
  });

  it("网络失败：降级成模板初稿，不抛错", async () => {
    const generator = new DeepSeekSummaryGenerator({
      apiKey: "test-key",
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });

    const draft = await generator.generate(INPUT);
    expect(draft.source).toBe("TEMPLATE");
    expect(draft.summaryZh.length).toBeGreaterThan(0);
  });

  it("接口报错 / 返回结构不对：都降级成模板初稿", async () => {
    const failing = new DeepSeekSummaryGenerator({
      apiKey: "test-key",
      fetchImpl: async () => new Response("nope", { status: 500 }),
    });
    expect((await failing.generate(INPUT)).source).toBe("TEMPLATE");

    const garbage = new DeepSeekSummaryGenerator({
      apiKey: "test-key",
      fetchImpl: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "随便说点什么" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    expect((await garbage.generate(INPUT)).source).toBe("TEMPLATE");
  });

  it("没配 API key：不发请求，直接降级", async () => {
    let called = false;
    const generator = new DeepSeekSummaryGenerator({
      apiKey: null,
      fetchImpl: async () => {
        called = true;
        return new Response("{}", { status: 200 });
      },
    });

    const draft = await generator.generate(INPUT);
    expect(called).toBe(false);
    expect(draft.source).toBe("TEMPLATE");
  });
});

describe("端口的注入点", () => {
  it("注入的假实现优先于默认实现", async () => {
    setSummaryGenerator({
      async generate() {
        return { summaryZh: "假的", whenToUse: null, howToUse: null, tags: [], source: "LLM" };
      },
    });

    const { getSummaryGenerator } = await import("@/lib/summary-generator");
    const draft = await getSummaryGenerator().generate(INPUT);
    expect(draft.summaryZh).toBe("假的");

    setSummaryGenerator(null);
  });
});
