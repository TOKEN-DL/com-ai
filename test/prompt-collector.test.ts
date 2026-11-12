/**
 * Prompt 采集适配器的 fixture 驱动测试（票 #15）。
 *
 * **一个网络请求都不打**：HTTP 客户端被换成打桩实现，按 URL 路由到录制的 fixture。
 *
 * 覆盖：
 *   1. 正常条目 —— 解析、模态、工具标签、许可证 override 全部生效；
 *   2. 结构变更 —— 抛 SourceStructureError，不静默返回空；
 *   3. 许可证 override —— 决定写入 `Asset.license` 的值；
 *   4. 逐字一致 —— 采集出来的正文能在来源文件里原样找到。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SourceStructureError } from "@/collector/errors";
import type { HttpClient } from "@/collector/http";
import { parseCsvRecords } from "@/collector/prompt-parse";
import { PromptRepoAdapter } from "@/collector/prompt-repo";
import { licenseOverrideId, type LicenseOverrideRow } from "@/lib/license-override";

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "prompt-repo",
);

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), "utf8");
}

type Route = { match: (url: string) => boolean; body: (url: string) => string };

/** 打桩的 HTTP 客户端：按 URL 路由到 fixture。记录调用过的 URL。 */
function createStubHttp(routes: Route[]): { http: HttpClient; calls: string[] } {
  const calls: string[] = [];

  const http: HttpClient = async (url) => {
    calls.push(url);
    const route = routes.find((candidate) => candidate.match(url));
    if (!route) {
      throw new Error(`fixture 未覆盖这个 URL：${url}`);
    }
    return new Response(route.body(url), { status: 200 });
  };

  return { http, calls };
}

/** 造一个 override 行。 */
function override(
  repoSlug: string,
  spdxId: string,
  appliesTo: string[],
  extra: Partial<LicenseOverrideRow> = {},
): LicenseOverrideRow {
  return {
    id: licenseOverrideId(repoSlug, spdxId, appliesTo),
    repoSlug,
    spdxId,
    appliesTo,
    evidence: "测试用证据",
    attribution: null,
    note: null,
    ...extra,
  };
}

/**
 * `f/prompts.chat` 的路由：
 *   - 仓库元数据 → `NOASSERTION`（GitHub 认不出这个仓库的一仓两许可）；
 *   - raw 文件 → 录制的 CSV。
 */
function promptsChatRoutes(csv = fixture("prompts-chat.csv")): Route[] {
  return [
    {
      match: (url) => url === "https://api.github.com/repos/f/prompts.chat",
      body: () =>
        JSON.stringify({
          license: { spdx_id: "NOASSERTION", name: "Other" },
          stargazers_count: 1234,
          pushed_at: "2026-11-01T00:00:00Z",
        }),
    },
    {
      match: (url) =>
        url === "https://raw.githubusercontent.com/f/prompts.chat/main/prompts.csv",
      body: () => csv,
    },
  ];
}

describe("Prompt 采集适配器 —— 正常条目", () => {
  it("解析出条目，模态 / 工具标签 / 贡献者都对", async () => {
    const { http } = createStubHttp(promptsChatRoutes());
    const adapter = new PromptRepoAdapter({
      http,
      overrides: [override("f/prompts.chat", "cc0-1.0", ["prompts.csv"])],
    });

    const result = await adapter.fetch({ type: "prompt-repo", source: "f/prompts.chat" });

    expect(result.sourceType).toBe("prompt-repo");
    // 5 条数据行。
    expect(result.items).toHaveLength(5);

    const ethereum = result.items.find((item) => item.title === "Ethereum Developer");
    expect(ethereum?.metadata.kind).toBe("PROMPT");
    expect(ethereum?.metadata.prompt?.modality).toBe("TEXT");
    expect(ethereum?.metadata.prompt?.toolTags).toEqual(["chatgpt"]);
    expect(ethereum?.metadata.prompt?.contributor).toBe("ameya-2003");
    expect(ethereum?.metadata.prompt?.forDevs).toBe("true");
    // 来源链接指向仓库里的具体文件。
    expect(ethereum?.metadata.upstreamUrl).toContain("f/prompts.chat/blob/main/prompts.csv");
  });

  it("override 决定写入的许可证值（没有 override 就是上游声明的 NOASSERTION）", async () => {
    const { http } = createStubHttp(promptsChatRoutes());
    const adapter = new PromptRepoAdapter({
      http,
      overrides: [override("f/prompts.chat", "cc0-1.0", ["prompts.csv"])],
    });

    const withOverride = await adapter.fetch({
      type: "prompt-repo",
      source: "f/prompts.chat",
    });
    expect(withOverride.items[0]?.metadata.license).toBe("cc0-1.0");

    // 同一个源，不给 override → 沿用上游声明的 NOASSERTION。
    const noOverride = new PromptRepoAdapter({ http, overrides: [] });
    const withoutOverride = await noOverride.fetch({
      type: "prompt-repo",
      source: "f/prompts.chat",
    });
    expect(withoutOverride.items[0]?.metadata.license).toBe("noassertion");
    expect(withoutOverride.error).toContain("METADATA_ONLY");
  });

  it("正文逐字：采集出来的内容与重新解析来源的结果完全一致", async () => {
    const csv = fixture("prompts-chat.csv");
    const { http } = createStubHttp(promptsChatRoutes(csv));
    const adapter = new PromptRepoAdapter({
      http,
      overrides: [override("f/prompts.chat", "cc0-1.0", ["prompts.csv"])],
    });

    const result = await adapter.fetch({ type: "prompt-repo", source: "f/prompts.chat" });

    // ⚠️ CSV 的「逐字」口径是「解码后的字段值」与来源重新解析的结果逐字相等，
    //    而不是原始文件里的字面子串（引号在 CSV 里是 `""` 转义的）。
    const records = parseCsvRecords(csv).slice(1);
    expect(result.items).toHaveLength(records.length);

    result.items.forEach((item, index) => {
      expect(item.content).toBe(records[index]?.fields[1]);
      // 正文与扩展表里的正文是同一个字符串。
      expect(item.metadata.prompt?.promptBody).toBe(item.content);
    });
  });

  it("slug 由内容决定：同样的输入产出同样的 slug（重采幂等）", async () => {
    const { http } = createStubHttp(promptsChatRoutes());
    const adapter = new PromptRepoAdapter({
      http,
      overrides: [override("f/prompts.chat", "cc0-1.0", ["prompts.csv"])],
    });

    const first = await adapter.fetch({ type: "prompt-repo", source: "f/prompts.chat" });
    const second = await adapter.fetch({ type: "prompt-repo", source: "f/prompts.chat" });

    expect(second.items.map((item) => item.slug)).toEqual(
      first.items.map((item) => item.slug),
    );
    expect(new Set(first.items.map((item) => item.slug)).size).toBe(first.items.length);
  });
});

describe("Prompt 采集适配器 —— CC BY 4.0 的源", () => {
  it("override 命中后带上署名要求", async () => {
    const attribution =
      "YouMind OpenLab / awesome-seedance-2-prompts — CC BY 4.0 — https://github.com/YouMind-OpenLab/awesome-seedance-2-prompts";
    const { http } = createStubHttp([
      {
        match: (url) =>
          url === "https://api.github.com/repos/YouMind-OpenLab/awesome-seedance-2-prompts",
        body: () =>
          JSON.stringify({
            license: { spdx_id: "NOASSERTION" },
            stargazers_count: 2200,
            pushed_at: "2026-11-01T00:00:00Z",
          }),
      },
      {
        match: (url) =>
          url ===
          "https://raw.githubusercontent.com/YouMind-OpenLab/awesome-seedance-2-prompts/main/README.md",
        body: () => fixture("youmind-readme.md"),
      },
    ]);

    const adapter = new PromptRepoAdapter({
      http,
      overrides: [
        override("YouMind-OpenLab/awesome-seedance-2-prompts", "cc-by-4.0", ["README*.md"], {
          attribution,
        }),
      ],
    });

    const result = await adapter.fetch({
      type: "prompt-repo",
      source: "YouMind-OpenLab/awesome-seedance-2-prompts",
    });

    expect(result.items.length).toBeGreaterThan(0);
    for (const item of result.items) {
      expect(item.metadata.license).toBe("cc-by-4.0");
      expect(item.metadata.prompt?.attribution).toBe(attribution);
      expect(item.metadata.prompt?.modality).toBe("VIDEO");
      expect(item.metadata.prompt?.toolTags).toContain("seedance");
    }
  });
});

describe("Prompt 采集适配器 —— 结构变更必须显式失败", () => {
  it("CSV 表头变了要抛 SourceStructureError", async () => {
    const broken = fixture("prompts-chat.csv").replace(
      "act,prompt,for_devs,type,contributor",
      "act,prompt,for_devs,type",
    );
    const { http } = createStubHttp(promptsChatRoutes(broken));
    const adapter = new PromptRepoAdapter({
      http,
      overrides: [override("f/prompts.chat", "cc0-1.0", ["prompts.csv"])],
    });

    await expect(adapter.fetch({ type: "prompt-repo", source: "f/prompts.chat" })).rejects.toThrow(
      SourceStructureError,
    );
  });

  it("JSON 顶层形状变了要抛 SourceStructureError", async () => {
    const { http } = createStubHttp([
      {
        match: (url) =>
          url === "https://api.github.com/repos/CHENJIAMIAN/awesome-chatgpt-prompts-zh-CN",
        body: () => JSON.stringify({ license: { spdx_id: "CC0-1.0" }, stargazers_count: 205 }),
      },
      {
        match: (url) =>
          url ===
          "https://raw.githubusercontent.com/CHENJIAMIAN/awesome-chatgpt-prompts-zh-CN/main/chatgpt_prompts-zh-CN.json",
        body: () => JSON.stringify({ prompts: [] }),
      },
    ]);
    const adapter = new PromptRepoAdapter({ http, overrides: [] });

    await expect(
      adapter.fetch({ type: "prompt-repo", source: "CHENJIAMIAN/awesome-chatgpt-prompts-zh-CN" }),
    ).rejects.toThrow(SourceStructureError);
  });

  it("Markdown 锚点不见了要抛 SourceStructureError", async () => {
    const { http } = createStubHttp([
      {
        match: (url) =>
          url === "https://api.github.com/repos/YouMind-OpenLab/awesome-seedance-2-prompts",
        body: () => JSON.stringify({ license: { spdx_id: "NOASSERTION" } }),
      },
      {
        match: (url) =>
          url ===
          "https://raw.githubusercontent.com/YouMind-OpenLab/awesome-seedance-2-prompts/main/README.md",
        body: () => "# 全新结构\n\n这里没有任何 prompt 标记。\n",
      },
    ]);
    const adapter = new PromptRepoAdapter({ http, overrides: [] });

    await expect(
      adapter.fetch({
        type: "prompt-repo",
        source: "YouMind-OpenLab/awesome-seedance-2-prompts",
      }),
    ).rejects.toThrow(SourceStructureError);
  });

  it("配置不合法（未知源）要抛 SourceConfigError", async () => {
    const adapter = new PromptRepoAdapter({ http: createStubHttp([]).http, overrides: [] });
    await expect(
      adapter.fetch({ type: "prompt-repo", source: "not/a-real-source" }),
    ).rejects.toThrow(/未知的语料源/);
  });
});

describe("Prompt 采集适配器 —— 文件树展开", () => {
  it("带 glob 的路径按文件树展开，并排除子树", async () => {
    const { http, calls } = createStubHttp([
      {
        match: (url) =>
          url === "https://api.github.com/repos/bytedance/Video-As-Prompt/git/trees/main?recursive=1",
        body: () =>
          JSON.stringify({
            truncated: false,
            tree: [
              {
                path: "examples/training/sft/cogvideox/crush_smol_lora/validation.json",
                type: "blob",
              },
              {
                path: "examples/training/sft/cogvideox/crush_smol_lora/validation_i2v.json",
                type: "blob",
              },
              // 索引文件：形状不同，但不是结构变更。
              {
                path: "examples/training/sft/cogvideox/vap_mot/validation.json",
                type: "blob",
              },
              // 子树里的无关文件：不能被收进来。
              { path: "diffusers/examples/community/README.md", type: "blob" },
              { path: "examples/training/sft/cogvideox/notes.md", type: "blob" },
            ],
          }),
      },
      {
        match: (url) => url === "https://api.github.com/repos/bytedance/Video-As-Prompt",
        body: () =>
          JSON.stringify({
            license: { spdx_id: "Apache-2.0" },
            stargazers_count: 463,
            pushed_at: "2026-11-01T00:00:00Z",
          }),
      },
      {
        match: (url) =>
          url.startsWith("https://raw.githubusercontent.com/bytedance/Video-As-Prompt/main/"),
        body: (url) => {
          if (url.includes("vap_mot/validation.json")) {
            // 索引文件：形状不同，但不是结构变更。
            return JSON.stringify({ root: "data/x", val_data: ["vap_data.csv"] });
          }
          // 两个文件给**不同**的正文 —— 否则会被去重逻辑合并掉，
          // 断言就看不出「按文件树展开」这件事了。
          if (url.includes("validation_i2v.json")) {
            return JSON.stringify({
              data: [
                { caption: "I2V 专用：镜头从静止的花朵缓缓推进到特写" },
                { caption: "I2V 专用：海浪拍打礁石，慢动作，水花飞溅" },
              ],
            });
          }
          return fixture("video-as-prompt-validation.json");
        },
      },
    ]);

    const adapter = new PromptRepoAdapter({ http, overrides: [] });
    const result = await adapter.fetch({
      type: "prompt-repo",
      source: "bytedance/Video-As-Prompt",
    });

    // 三个文件：两个有内联条目（各 2 条），一个是索引文件（0 条）。
    expect(result.items).toHaveLength(4);
    // diffusers/ 子树里的文件没有被拉。
    expect(
      calls.some((url) => url.includes("diffusers/examples/community/README.md")),
    ).toBe(false);
    // notes.md 不匹配 validation*.json。
    expect(calls.some((url) => url.includes("notes.md"))).toBe(false);
    // Apache-2.0 在白名单里 → FULL 档的许可证值。
    expect(result.items[0]?.metadata.license).toBe("apache-2.0");
  });

  it("文件树被截断时要显式失败（结果不可信）", async () => {
    const { http } = createStubHttp([
      {
        match: (url) =>
          url === "https://api.github.com/repos/bytedance/Video-As-Prompt/git/trees/main?recursive=1",
        body: () => JSON.stringify({ truncated: true, tree: [] }),
      },
      {
        match: (url) => url === "https://api.github.com/repos/bytedance/Video-As-Prompt",
        body: () => JSON.stringify({ license: { spdx_id: "Apache-2.0" } }),
      },
    ]);

    const adapter = new PromptRepoAdapter({ http, overrides: [] });
    await expect(
      adapter.fetch({ type: "prompt-repo", source: "bytedance/Video-As-Prompt" }),
    ).rejects.toThrow(SourceStructureError);
  });
});
