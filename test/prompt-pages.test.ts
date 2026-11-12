/**
 * Prompt 页面的 HTTP 边界（票 #15）。
 *
 * 页面与接口对着**真实测试 Postgres** 跑（不用内存替身）。
 *
 * 覆盖票里的验收标准：
 *   1. 可按模态筛选；
 *   2. 可按工具 / 模型筛选；
 *   3. 每条标注原始来源链接与许可证标识；
 *   4. 一键复制出的提示词原文与来源**逐字一致**；
 *   5. Prompt 条目能被统一搜索命中。
 *
 * 数据通过 #3 的写入路径（writeAsset）落库 —— 与生产链路一致。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GET as getPromptApi } from "@/app/api/prompts/[slug]/route";
import PromptDetailPage from "@/app/prompts/[slug]/page";
import PromptListPage from "@/app/prompts/page";
import { GET as searchApi } from "@/app/api/search/route";
import SearchPage from "@/app/search/page";
import { writeAsset } from "@/lib/asset-writer";

/**
 * 一条**逐字**很讲究的提示词正文。
 *
 * 刻意包含：内部空行、行尾空格、引号、末尾换行 ——
 * 任何 trim / 规范化都会在这里露馅。
 */
const VERBATIM_BODY = [
  "You are a meticulous code reviewer.",
  "",
  "Review the diff and report:",
  "  1. correctness issues",
  "  2. readability issues   ",
  "",
  'Answer with the exact phrase "No issues found" when there is nothing to report.',
  "",
].join("\n");

const VIDEO_BODY = "Slow aerial dolly over a fog-covered pine forest at dawn, volumetric light.";

/**
 * React 在文本节点里对这几个字符的转义规则。
 *
 * 比对渲染结果时必须用同样的规则，否则会因为转义差异误判成「正文不一致」。
 */
function escapeForHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/** 种一批 prompt：四种模态各一条，外加一条 CC BY 4.0 的署名条目。 */
async function seedPrompts(): Promise<void> {
  await writeAsset({
    kind: "PROMPT",
    slug: "prompt-text-reviewer",
    displayName: "代码审阅助手",
    license: "cc0-1.0",
    contentBody: VERBATIM_BODY,
    summaryZh: "来自 f/prompts.chat 的文本提示词「代码审阅助手」。",
    summarySource: "TEMPLATE",
    repoOwner: "f",
    repoName: "prompts.chat",
    repoUrl: "https://github.com/f/prompts.chat",
    upstreamUrl: "https://github.com/f/prompts.chat/blob/main/prompts.csv",
    sourceId: "f/prompts.chat",
    detail: {
      prompt: {
        modality: "TEXT",
        act: "代码审阅助手",
        promptBody: VERBATIM_BODY,
        forDevs: "true",
        contributor: "ameya-2003",
        toolTags: ["chatgpt"],
        attribution: null,
      },
    },
  });

  await writeAsset({
    kind: "PROMPT",
    slug: "prompt-video-seedance",
    displayName: "Seedance 森林航拍",
    license: "cc-by-4.0",
    contentBody: VIDEO_BODY,
    summaryZh: "来自 YouMind-OpenLab/awesome-seedance-2-prompts 的视频提示词「Seedance 森林航拍」。",
    summarySource: "TEMPLATE",
    repoOwner: "YouMind-OpenLab",
    repoName: "awesome-seedance-2-prompts",
    repoUrl: "https://github.com/YouMind-OpenLab/awesome-seedance-2-prompts",
    upstreamUrl:
      "https://github.com/YouMind-OpenLab/awesome-seedance-2-prompts/blob/main/README.md",
    sourceId: "YouMind-OpenLab/awesome-seedance-2-prompts",
    detail: {
      prompt: {
        modality: "VIDEO",
        act: "Seedance 森林航拍",
        promptBody: VIDEO_BODY,
        forDevs: null,
        contributor: null,
        toolTags: ["seedance", "seedance-2"],
        attribution:
          "YouMind OpenLab / awesome-seedance-2-prompts — CC BY 4.0 — https://github.com/YouMind-OpenLab/awesome-seedance-2-prompts",
      },
    },
  });

  await writeAsset({
    kind: "PROMPT",
    slug: "prompt-image-flux",
    displayName: "Flux 工匠肖像",
    license: null,
    contentBody: null,
    summaryZh: "来自 Anil-matcha/awesome-flux-3-api-prompts 的图片提示词「Flux 工匠肖像」。",
    summarySource: "TEMPLATE",
    repoOwner: "Anil-matcha",
    repoName: "awesome-flux-3-api-prompts",
    repoUrl: "https://github.com/Anil-matcha/awesome-flux-3-api-prompts",
    upstreamUrl:
      "https://github.com/Anil-matcha/awesome-flux-3-api-prompts/blob/main/README.md",
    sourceId: "Anil-matcha/awesome-flux-3-api-prompts",
    detail: {
      prompt: {
        modality: "IMAGE",
        act: "Flux 工匠肖像",
        promptBody: null,
        forDevs: null,
        contributor: null,
        toolTags: ["flux", "flux-3"],
        attribution: null,
      },
    },
  });

  await writeAsset({
    kind: "PROMPT",
    slug: "prompt-music-suno",
    displayName: "Suno 90 年代 R&B",
    license: "cc0-1.0",
    contentBody: "90s R&B, lush group harmonies, new jack swing groove, warm analog keys.",
    summaryZh: "来自 samuelgrupolimex-prog/suno-style-recipes 的音乐提示词「Suno 90 年代 R&B」。",
    summarySource: "TEMPLATE",
    repoOwner: "samuelgrupolimex-prog",
    repoName: "suno-style-recipes",
    repoUrl: "https://github.com/samuelgrupolimex-prog/suno-style-recipes",
    upstreamUrl:
      "https://github.com/samuelgrupolimex-prog/suno-style-recipes/blob/main/styles.csv",
    sourceId: "samuelgrupolimex-prog/suno-style-recipes",
    detail: {
      prompt: {
        modality: "MUSIC",
        act: "90s R&B Revival",
        promptBody: "90s R&B, lush group harmonies, new jack swing groove, warm analog keys.",
        forDevs: null,
        contributor: null,
        toolTags: ["suno"],
        attribution: null,
      },
    },
  });
}

describe("/prompts 列表页", () => {
  it("列出 prompt 并指向各自的详情页", async () => {
    await seedPrompts();

    const element = await PromptListPage({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(element);

    expect(html).toContain('href="/prompts/prompt-text-reviewer"');
    expect(html).toContain('href="/prompts/prompt-video-seedance"');
    expect(html).toContain("代码审阅助手");
  });

  it("按模态筛选：只看得到该模态的条目", async () => {
    await seedPrompts();

    const element = await PromptListPage({
      searchParams: Promise.resolve({ modality: "VIDEO" }),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain('href="/prompts/prompt-video-seedance"');
    expect(html).not.toContain('href="/prompts/prompt-text-reviewer"');
    expect(html).not.toContain('href="/prompts/prompt-music-suno"');
  });

  it("按工具 / 模型筛选：只看得到带该工具的条目", async () => {
    await seedPrompts();

    const element = await PromptListPage({
      searchParams: Promise.resolve({ tool: "flux" }),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain('href="/prompts/prompt-image-flux"');
    expect(html).not.toContain('href="/prompts/prompt-video-seedance"');
  });

  it("模态与工具可以叠加筛选", async () => {
    await seedPrompts();

    const element = await PromptListPage({
      searchParams: Promise.resolve({ modality: "VIDEO", tool: "seedance" }),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain('href="/prompts/prompt-video-seedance"');
  });

  it("筛不出东西时给出提示而不是白屏", async () => {
    await seedPrompts();

    const element = await PromptListPage({
      searchParams: Promise.resolve({ modality: "MUSIC", tool: "flux" }),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("没有匹配的条目");
  });
});

describe("/prompts/[slug] 详情页", () => {
  it("展示原文、来源链接与许可证标识", async () => {
    await seedPrompts();

    const element = await PromptDetailPage({
      params: Promise.resolve({ slug: "prompt-text-reviewer" }),
    });
    const html = renderToStaticMarkup(element);

    // 许可证标识。
    expect(html).toContain("cc0-1.0");
    // 原始来源链接（仓库 + 原文位置）。
    expect(html).toContain("https://github.com/f/prompts.chat");
    expect(html).toContain(
      "https://github.com/f/prompts.chat/blob/main/prompts.csv",
    );
    // 模态与工具标签。
    expect(html).toContain("文本");
    expect(html).toContain("chatgpt");
    // 正文原样出现在页面上。
    expect(html).toContain("You are a meticulous code reviewer.");
    expect(html).toContain("No issues found");
  });

  it("CC BY 4.0 的条目展示署名要求", async () => {
    await seedPrompts();

    const element = await PromptDetailPage({
      params: Promise.resolve({ slug: "prompt-video-seedance" }),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("cc-by-4.0");
    expect(html).toContain("CC BY 4.0");
    expect(html).toContain("https://github.com/YouMind-OpenLab/awesome-seedance-2-prompts");
  });

  it("METADATA_ONLY 的条目不展示正文，只给原文链接", async () => {
    await seedPrompts();

    const element = await PromptDetailPage({
      params: Promise.resolve({ slug: "prompt-image-flux" }),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("仅元数据");
    expect(html).toContain("原仓库");
    // 正文没有被复制到站内。
    expect(html).not.toContain("copy-button");
  });

  it("不存在的 slug 返回 404", async () => {
    await seedPrompts();

    const response = await getPromptApi(
      new Request("http://localhost/api/prompts/not-there"),
      { params: Promise.resolve({ slug: "not-there" }) },
    );

    expect(response.status).toBe(404);
  });
});

describe("一键复制：逐字一致", () => {
  it("接口返回的 copyText 与来源逐字一致（不 trim、不规范化）", async () => {
    await seedPrompts();

    const response = await getPromptApi(
      new Request("http://localhost/api/prompts/prompt-text-reviewer"),
      { params: Promise.resolve({ slug: "prompt-text-reviewer" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    // 逐字相等：末尾换行、行尾空格、内部空行一个都不能少。
    expect(body.copyText).toBe(VERBATIM_BODY);
    expect(body.promptBody).toBe(VERBATIM_BODY);
    expect(body.copyText.endsWith("\n")).toBe(true);
    expect(body.copyText).toContain("readability issues   \n");
    // 长度也逐字对得上（防止有字符被悄悄替换掉）。
    expect(body.copyText.length).toBe(VERBATIM_BODY.length);
  });

  it("详情页展示的正文与接口返回的 copyText 是同一段", async () => {
    await seedPrompts();

    const response = await getPromptApi(
      new Request("http://localhost/api/prompts/prompt-text-reviewer"),
      { params: Promise.resolve({ slug: "prompt-text-reviewer" }) },
    );
    const body = await response.json();

    const element = await PromptDetailPage({
      params: Promise.resolve({ slug: "prompt-text-reviewer" }),
    });
    const html = renderToStaticMarkup(element);

    // 页面上的 <pre> 里就是这段原文。
    // React 在文本节点里会转义 & < > " ' 五个字符 —— 比对时要用同样的规则。
    expect(html).toContain(escapeForHtml(VERBATIM_BODY));
    // 页面与接口给的是同一段（同一个视图模型）。
    expect(body.copyText).toBe(VERBATIM_BODY);
  });
});

describe("统一搜索", () => {
  it("Prompt 条目能被统一搜索命中", async () => {
    await seedPrompts();

    const response = await searchApi(new Request("http://localhost/api/search?q=代码审阅"));
    const body = await response.json();

    expect(body.total).toBe(1);
    expect(body.items[0].slug).toBe("prompt-text-reviewer");
    expect(body.items[0].kind).toBe("PROMPT");
    // 分类分面里能看到 PROMPT。
    expect(body.facets.kind).toEqual(
      expect.arrayContaining([{ value: "PROMPT", count: 1 }]),
    );
  });

  it("统一搜索页把 PROMPT 结果指向 /prompts/{slug}", async () => {
    await seedPrompts();

    const element = await SearchPage({
      searchParams: Promise.resolve({ q: "代码审阅" }),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain('href="/prompts/prompt-text-reviewer"');
  });

  it("统一搜索页给出模态与工具/模型的筛选入口", async () => {
    await seedPrompts();

    const element = await SearchPage({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(element);

    // 两个分面组都在。
    expect(html).toContain("模态");
    expect(html).toContain("工具 / 模型");
    // 分面带命中数量。
    expect(html).toContain("seedance（1）");
    expect(html).toContain("suno（1）");
    // 筛选链接带上参数。
    expect(html).toContain("modality=VIDEO");
    expect(html).toContain("tool=seedance");
  });

  it("统一搜索支持按模态与工具筛选", async () => {
    await seedPrompts();

    const response = await searchApi(
      new Request("http://localhost/api/search?kind=PROMPT&modality=VIDEO"),
    );
    const body = await response.json();

    expect(body.total).toBe(1);
    expect(body.items[0].slug).toBe("prompt-video-seedance");
    expect(body.query.filters.modality).toEqual(["VIDEO"]);

    const byTool = await searchApi(
      new Request("http://localhost/api/search?kind=PROMPT&tool=suno"),
    );
    const toolBody = await byTool.json();
    expect(toolBody.total).toBe(1);
    expect(toolBody.items[0].slug).toBe("prompt-music-suno");
  });

  it("模态与工具分面能给出命中数量", async () => {
    await seedPrompts();

    const response = await searchApi(new Request("http://localhost/api/search?kind=PROMPT"));
    const body = await response.json();

    const modalityFacet = new Map(
      body.facets.modality.map((bucket: { value: string; count: number }) => [
        bucket.value,
        bucket.count,
      ]),
    );
    expect(modalityFacet.get("TEXT")).toBe(1);
    expect(modalityFacet.get("VIDEO")).toBe(1);
    expect(modalityFacet.get("MUSIC")).toBe(1);
    expect(modalityFacet.get("IMAGE")).toBe(1);

    const toolFacet = new Map(
      body.facets.tool.map((bucket: { value: string; count: number }) => [
        bucket.value,
        bucket.count,
      ]),
    );
    expect(toolFacet.get("seedance")).toBe(1);
    expect(toolFacet.get("suno")).toBe(1);
    expect(toolFacet.get("flux")).toBe(1);
  });
});
