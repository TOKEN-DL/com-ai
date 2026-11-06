/**
 * 中文简介服务（票 #7）：内容 hash、缓存键、人工覆盖判定、缓存命中/未命中、批量重跑。
 *
 * 纯函数那一侧不碰数据库；缓存与批量重跑跑在**真实测试 Postgres** 上
 * （不用内存替身 —— 缓存的唯一约束与触发器都要真数据库才作数）。
 */
import { afterEach, describe, expect, it } from "vitest";

import { ingestItems } from "@/collector/ingest";
import type { RawItem } from "@/collector/types";
import { writeAsset } from "@/lib/asset-writer";
import { prisma } from "@/lib/prisma";
import {
  buildSummaryCacheKey,
  computeContentHash,
  generateSummary,
  isHumanOverridden,
  overrideAssetSummary,
  regenerateSummaries,
  SUMMARY_GENERATOR_VERSION,
} from "@/lib/summary-service";
import {
  setSummaryGenerator,
  templateSummaryDraft,
  type SummaryDraft,
  type SummaryGenerator,
  type SummaryGeneratorInput,
} from "@/lib/summary-generator";

const BODY = "# pdf-skill\n\n把 PDF 转成 Markdown。";

afterEach(() => {
  setSummaryGenerator(null);
});

/** 假的简介生成器：记录每次调用，便于断言「有没有重复调模型」。 */
function countingGenerator(draft: Partial<SummaryDraft> = {}) {
  const calls: SummaryGeneratorInput[] = [];

  const generator: SummaryGenerator = {
    async generate(input) {
      calls.push(input);
      return {
        summaryZh: draft.summaryZh ?? "AI 写的中文简介。",
        whenToUse: draft.whenToUse ?? "批量处理 PDF 时使用。",
        howToUse: draft.howToUse ?? "安装后直接调用。",
        tags: draft.tags ?? ["文档处理"],
        source: draft.source ?? "LLM",
      };
    },
  };

  return { generator, calls };
}

/** 永远失败的生成器：模拟 LLM 挂了。 */
const brokenGenerator: SummaryGenerator = {
  async generate() {
    throw new Error("LLM 挂了");
  },
};

function generatorInput(overrides: Partial<SummaryGeneratorInput> = {}): SummaryGeneratorInput {
  return {
    kind: "SKILL",
    displayName: "pdf-skill",
    contentBody: BODY,
    contentHash: computeContentHash(BODY),
    sourceId: "github-repo",
    description: "把 PDF 转成 Markdown。",
    repoOwner: "example",
    repoName: "skills",
    license: "mit",
    ...overrides,
  };
}

/** 一个规范化条目（采集器的输出形状）。 */
function rawItem(overrides: Partial<RawItem> = {}): RawItem {
  return {
    slug: "example-skills-pdf-skill",
    title: "pdf-skill",
    url: "https://github.com/example/skills/blob/main/skills/pdf/SKILL.md",
    content: BODY,
    metadata: {
      kind: "SKILL",
      sourceId: "github-repo",
      description: "把 PDF 转成 Markdown。",
      frontmatter: { name: "pdf-skill", description: "把 PDF 转成 Markdown。" },
      license: "MIT",
      repoOwner: "example",
      repoName: "skills",
      repoUrl: "https://github.com/example/skills",
      upstreamUrl: "https://raw.githubusercontent.com/example/skills/main/skills/pdf/SKILL.md",
      skillPath: "skills/pdf/SKILL.md",
      extraFiles: [],
      stars: 1,
      installs: 2,
      heatScore: 3,
      isOfficial: false,
    },
    ...overrides,
  };
}

describe("内容 hash", () => {
  it("同一份内容算出同一个 hash，不同内容算出不同的 hash", () => {
    expect(computeContentHash(BODY)).toBe(computeContentHash(BODY));
    expect(computeContentHash(BODY)).not.toBe(computeContentHash(`${BODY}!`));
  });

  it("空内容（null / undefined / 空串）算出同一个 hash", () => {
    expect(computeContentHash(null)).toBe(computeContentHash(undefined));
    expect(computeContentHash(null)).toBe(computeContentHash(""));
  });
});

describe("缓存键", () => {
  it("缓存键 = 生成器版本 + 内容 hash", () => {
    const hash = computeContentHash(BODY);
    expect(buildSummaryCacheKey(hash, "v1")).toBe(`v1:${hash}`);
  });

  it("生成器版本变了，缓存键就变了 —— 这正是「模型/提示词变更后能重跑」的机制", () => {
    const hash = computeContentHash(BODY);
    expect(buildSummaryCacheKey(hash, "v1")).not.toBe(buildSummaryCacheKey(hash, "v2"));
  });

  it("内容变了，缓存键就变了", () => {
    expect(buildSummaryCacheKey(computeContentHash(BODY), "v1")).not.toBe(
      buildSummaryCacheKey(computeContentHash(`${BODY}!`), "v1"),
    );
  });
});

describe("人工覆盖判定", () => {
  it("summaryOverriddenAt 为空 = 没被覆盖过", () => {
    expect(isHumanOverridden({ summaryOverriddenAt: null })).toBe(false);
    expect(isHumanOverridden({ summaryOverriddenAt: undefined })).toBe(false);
  });

  it("summaryOverriddenAt 非空 = 覆盖过，批量重跑必须跳过", () => {
    expect(isHumanOverridden({ summaryOverriddenAt: new Date() })).toBe(true);
  });
});

describe("缓存的命中与未命中", () => {
  it("第一次未命中 → 调模型并写缓存；第二次命中 → 不再调模型", async () => {
    const { generator, calls } = countingGenerator();

    const first = await generateSummary(generatorInput(), { generator });
    expect(first.cached).toBe(false);
    expect(first.draft.source).toBe("LLM");
    expect(calls).toHaveLength(1);

    const second = await generateSummary(generatorInput(), { generator });
    expect(second.cached).toBe(true);
    expect(second.draft.summaryZh).toBe("AI 写的中文简介。");
    // 关键断言：第二次**没有**再调模型。
    expect(calls).toHaveLength(1);
  });

  it("缓存行落在 AssetSummaryCache，键是版本 + 内容 hash", async () => {
    const { generator } = countingGenerator();
    await generateSummary(generatorInput(), { generator });

    const rows = await prisma.assetSummaryCache.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].cacheKey).toBe(
      buildSummaryCacheKey(computeContentHash(BODY), SUMMARY_GENERATOR_VERSION),
    );
    expect(rows[0].generatorVersion).toBe(SUMMARY_GENERATOR_VERSION);
    expect(rows[0].summaryZh).toBe("AI 写的中文简介。");
  });

  it("模板降级**不写缓存** —— 一次网络抖动不该把简介永久固化在模板上", async () => {
    const result = await generateSummary(generatorInput(), { generator: brokenGenerator });

    expect(result.draft.source).toBe("TEMPLATE");
    expect(result.draft.summaryZh.length).toBeGreaterThan(0);
    expect(await prisma.assetSummaryCache.count()).toBe(0);
  });

  it("模型失败不抛错：降级成模板初稿", async () => {
    const result = await generateSummary(generatorInput(), { generator: brokenGenerator });
    const expected = templateSummaryDraft(generatorInput());

    expect(result.draft.summaryZh).toBe(expected.summaryZh);
    expect(result.draft.source).toBe("TEMPLATE");
  });
});

describe("采集入库时的简介生成", () => {
  it("同一份内容重复采集 → 只调一次模型", async () => {
    const { generator, calls } = countingGenerator();
    setSummaryGenerator(generator);

    await ingestItems([rawItem()]);
    await ingestItems([rawItem()]);

    // 关键断言：第二次采集命中缓存，没有再调模型。
    expect(calls).toHaveLength(1);
  });

  it("同一份内容换个来源（不同 slug）也不重复调模型 —— 缓存认的是内容，不是资产", async () => {
    const { generator, calls } = countingGenerator();
    setSummaryGenerator(generator);

    await ingestItems([rawItem()]);

    const forked = rawItem();
    await ingestItems([
      {
        ...forked,
        slug: "another-owner-skills-pdf-skill",
        metadata: { ...forked.metadata, repoOwner: "another-owner" },
      },
    ]);

    expect(calls).toHaveLength(1);

    const assets = await prisma.asset.findMany({ orderBy: { slug: "asc" } });
    expect(assets.map((asset) => asset.slug)).toEqual([
      "another-owner-skills-pdf-skill",
      "example-skills-pdf-skill",
    ]);
    // 两条资产的简介一样 —— 同一份内容，生成一次就够。
    expect(assets[0].summaryZh).toBe(assets[1].summaryZh);
  });

  it("FULL 档：简介落库，来源标记为 LLM，「何时用 / 怎么用」都写进去", async () => {
    const { generator } = countingGenerator();
    setSummaryGenerator(generator);

    await ingestItems([rawItem()]);

    const asset = await prisma.asset.findUniqueOrThrow({
      where: { slug: "example-skills-pdf-skill" },
    });
    expect(asset.summarySource).toBe("LLM");
    expect(asset.summaryZh).toBe("AI 写的中文简介。");
    expect(asset.whenToUse).toBe("批量处理 PDF 时使用。");
    expect(asset.howToUse).toBe("安装后直接调用。");
  });

  it("METADATA_ONLY 档：不调模型（站内不复制原文，也不据原文写简介）", async () => {
    const { generator, calls } = countingGenerator();
    setSummaryGenerator(generator);

    const item = rawItem();
    await ingestItems([
      {
        ...item,
        metadata: { ...item.metadata, license: null },
      },
    ]);

    expect(calls).toHaveLength(0);

    const asset = await prisma.asset.findUniqueOrThrow({
      where: { slug: "example-skills-pdf-skill" },
    });
    expect(asset.contentTier).toBe("METADATA_ONLY");
    expect(asset.summarySource).toBe("TEMPLATE");
    expect(asset.whenToUse).toBeNull();
    expect(asset.howToUse).toBeNull();
  });

  it("模型抛错：资产**仍然入库**，简介降级显示，来源标记为 TEMPLATE", async () => {
    setSummaryGenerator(brokenGenerator);

    const report = await ingestItems([rawItem()]);

    expect(report.failed).toBe(0);
    expect(report.written).toBe(1);

    const asset = await prisma.asset.findUniqueOrThrow({
      where: { slug: "example-skills-pdf-skill" },
    });
    expect(asset.summarySource).toBe("TEMPLATE");
    expect(asset.summaryZh).not.toBeNull();
    expect((asset.summaryZh ?? "").length).toBeGreaterThan(0);
    expect(asset.contentBody).toBe(BODY);
  });
});

describe("批量重跑", () => {
  it("人工覆盖过的资产被跳过，简介不被改回去", async () => {
    const { generator, calls } = countingGenerator();
    setSummaryGenerator(generator);

    await writeAsset({
      kind: "SKILL",
      slug: "human-owned",
      displayName: "pdf-skill",
      license: "MIT",
      contentBody: BODY,
      summaryZh: "AI 初稿。",
      summarySource: "LLM",
      repoOwner: "example",
      repoName: "skills",
    });

    const asset = await prisma.asset.findUniqueOrThrow({ where: { slug: "human-owned" } });
    const overridden = await overrideAssetSummary({
      assetId: asset.id,
      summaryZh: "人工改写的简介。",
      whenToUse: "人工写的何时用。",
      howToUse: "人工写的怎么用。",
      operatorId: "user-1",
    });
    expect(overridden.ok).toBe(true);

    const report = await regenerateSummaries({}, { generator });

    expect(report.skippedOverridden).toBe(1);
    expect(report.regenerated).toBe(0);
    expect(calls).toHaveLength(0);

    const after = await prisma.asset.findUniqueOrThrow({ where: { slug: "human-owned" } });
    expect(after.summaryZh).toBe("人工改写的简介。");
    expect(after.summarySource).toBe("HUMAN");
    expect(after.whenToUse).toBe("人工写的何时用。");
    expect(after.howToUse).toBe("人工写的怎么用。");
  });

  it("人工覆盖：来源变成 HUMAN，并记下覆盖时间与覆盖人", async () => {
    await writeAsset({
      kind: "SKILL",
      slug: "override-me",
      displayName: "pdf-skill",
      license: "MIT",
      contentBody: BODY,
      summaryZh: "AI 初稿。",
      summarySource: "LLM",
    });

    const asset = await prisma.asset.findUniqueOrThrow({ where: { slug: "override-me" } });
    await overrideAssetSummary({
      assetId: asset.id,
      summaryZh: "人工改写的简介。",
      whenToUse: null,
      howToUse: null,
      operatorId: "user-42",
    });

    const after = await prisma.asset.findUniqueOrThrow({ where: { slug: "override-me" } });
    expect(after.summarySource).toBe("HUMAN");
    expect(after.summaryOverriddenAt).not.toBeNull();
    expect(after.summaryOverriddenBy).toBe("user-42");
    expect(after.whenToUse).toBeNull();
    expect(after.howToUse).toBeNull();
  });

  it("重新采集也不覆盖人工写过的简介", async () => {
    const { generator } = countingGenerator();
    setSummaryGenerator(generator);

    await writeAsset({
      kind: "SKILL",
      slug: "keep-human",
      displayName: "pdf-skill",
      license: "MIT",
      contentBody: BODY,
      summaryZh: "AI 初稿。",
      summarySource: "LLM",
    });

    const asset = await prisma.asset.findUniqueOrThrow({ where: { slug: "keep-human" } });
    await overrideAssetSummary({
      assetId: asset.id,
      summaryZh: "人工改写的简介。",
      whenToUse: "何时。",
      howToUse: "怎么。",
      operatorId: "user-1",
    });

    // 重新采集同一份内容（AI 初稿会被重新生成一次）。
    await ingestItems([rawItem({ slug: "keep-human" })]);

    const after = await prisma.asset.findUniqueOrThrow({ where: { slug: "keep-human" } });
    expect(after.summaryZh).toBe("人工改写的简介。");
    expect(after.summarySource).toBe("HUMAN");
  });

  it("绕过服务层直接写库：人工覆盖过的简介也不会被改回去（触发器兜底）", async () => {
    await writeAsset({
      kind: "SKILL",
      slug: "trigger-guard",
      displayName: "pdf-skill",
      license: "MIT",
      contentBody: BODY,
      summaryZh: "AI 初稿。",
      summarySource: "LLM",
    });

    const asset = await prisma.asset.findUniqueOrThrow({ where: { slug: "trigger-guard" } });
    await prisma.asset.update({
      where: { id: asset.id },
      data: {
        summaryZh: "人工改写的简介。",
        summarySource: "HUMAN",
        summaryOverriddenAt: new Date(),
        summaryOverriddenBy: "user-1",
      },
    });

    // 绕过服务层直接写库（模拟另一个脚本 / 后台任务）。
    await prisma.asset.update({
      where: { id: asset.id },
      data: { summaryZh: "机器又写了一遍。", summarySource: "LLM" },
    });

    const after = await prisma.asset.findUniqueOrThrow({ where: { slug: "trigger-guard" } });
    expect(after.summaryZh).toBe("人工改写的简介。");
    expect(after.summarySource).toBe("HUMAN");
  });

  it("生成器版本变了 → 缓存键变 → 重跑会重新调模型", async () => {
    const { generator, calls } = countingGenerator();

    await writeAsset({
      kind: "SKILL",
      slug: "rerun-me",
      displayName: "pdf-skill",
      license: "MIT",
      contentBody: BODY,
      summaryZh: "旧初稿。",
      summarySource: "LLM",
      repoOwner: "example",
      repoName: "skills",
    });

    // 先用 v1 跑一次：写进缓存。
    const first = await regenerateSummaries({ generatorVersion: "v1" }, { generator });
    expect(first.regenerated).toBe(1);
    expect(calls).toHaveLength(1);

    // 再用 v1 跑：命中缓存，不调模型。
    const second = await regenerateSummaries({ generatorVersion: "v1" }, { generator });
    expect(second.cached).toBe(1);
    expect(second.regenerated).toBe(0);
    expect(calls).toHaveLength(1);

    // 换一版生成器（模拟模型或提示词变了）：缓存键对不上 → 重新调模型。
    const third = await regenerateSummaries({ generatorVersion: "v2" }, { generator });
    expect(third.regenerated).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it("重跑只处理 FULL 档：没有原文的资产被跳过", async () => {
    const { generator, calls } = countingGenerator();

    await writeAsset({
      kind: "SKILL",
      slug: "metadata-only",
      displayName: "pdf-skill",
      license: null,
      summaryZh: "模板简介。",
      summarySource: "TEMPLATE",
    });

    const report = await regenerateSummaries({}, { generator });

    expect(report.scanned).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
