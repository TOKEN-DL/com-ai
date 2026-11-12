/**
 * Prompt 的许可证分层（票 #15）。
 *
 * 验的是票里点名的那条因果链：
 *
 *   有 override → 写入 `Asset.license` 的是可再分发的 SPDX id
 *             → 触发器推导出 FULL 档
 *             → `promptBody` **入库**；
 *
 *   没有 override → 沿用上游声明的 NOASSERTION
 *             → 触发器推导出 METADATA_ONLY 档
 *             → `promptBody` **不入库**（库里确实是空的）。
 *
 * 另外核实一件事：**`promptBody` 到底有没有触发器保护**。
 * 票里怀疑「主表触发器只管 `Asset.contentBody`，管不到扩展表的 `promptBody`」。
 * 实测结论：有一个**专门的** `comai_guard_prompt_detail` 触发器
 * （迁移 20261106012632 里建的）挂在 `PromptDetail` 表上，
 * 它按 `Asset.contentTier` 清空 `NEW."promptBody"`。
 * 下面第三条测试就是**绕过服务层直接写库**来证明它确实生效。
 */
import { describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { writeAsset } from "@/lib/asset-writer";
import { resolveContentTier } from "@/lib/license-tier";
import {
  licenseOverrideId,
  resolveLicenseOverride,
  type LicenseOverrideRow,
} from "@/lib/license-override";

/** 造一行 override。 */
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

describe("Prompt 的许可证分层", () => {
  it("有 override：FULL 档，正文入库", async () => {
    const overrides = [override("f/prompts.chat", "cc0-1.0", ["prompts.csv"])];
    const resolved = resolveLicenseOverride(
      overrides,
      "f/prompts.chat",
      "prompts.csv",
      "NOASSERTION",
    );

    expect(resolved.spdxId).toBe("cc0-1.0");
    expect(resolveContentTier(resolved.spdxId)).toBe("FULL");

    await writeAsset({
      kind: "PROMPT",
      slug: "prompt-tier-full",
      displayName: "有 override 的提示词",
      license: resolved.spdxId,
      contentBody: "原文正文",
      summaryZh: "摘要",
      summarySource: "TEMPLATE",
      repoOwner: "f",
      repoName: "prompts.chat",
      detail: {
        prompt: {
          modality: "TEXT",
          act: "有 override 的提示词",
          promptBody: "原文正文",
          toolTags: ["chatgpt"],
        },
      },
    });

    // 直接查库确认（不看写入路径的返回值）。
    const asset = await prisma.asset.findUnique({
      where: { slug: "prompt-tier-full" },
      include: { promptDetail: true },
    });

    expect(asset?.license).toBe("cc0-1.0");
    expect(asset?.contentTier).toBe("FULL");
    expect(asset?.contentBody).toBe("原文正文");
    expect(asset?.promptDetail?.promptBody).toBe("原文正文");
  });

  it("没有 override：METADATA_ONLY 档，库里确实没有原文", async () => {
    // 上游没声明可再分发的许可（GitHub 认不出来 → NOASSERTION）。
    const resolved = resolveLicenseOverride([], "whoever/whatever", "README.md", "NOASSERTION");

    expect(resolveContentTier(resolved.spdxId)).toBe("METADATA_ONLY");

    await writeAsset({
      kind: "PROMPT",
      slug: "prompt-tier-metadata-only",
      displayName: "没有 override 的提示词",
      license: resolved.spdxId,
      contentBody: "不该入库的原文",
      summaryZh: "摘要",
      summarySource: "TEMPLATE",
      repoOwner: "whoever",
      repoName: "whatever",
      detail: {
        prompt: {
          modality: "TEXT",
          act: "没有 override 的提示词",
          promptBody: "不该入库的原文",
          toolTags: [],
        },
      },
    });

    const asset = await prisma.asset.findUnique({
      where: { slug: "prompt-tier-metadata-only" },
      include: { promptDetail: true },
    });

    expect(asset?.contentTier).toBe("METADATA_ONLY");
    // ⚠️ 关键断言：**库里**确实没有原文（不只是写入路径没返回）。
    expect(asset?.contentBody).toBeNull();
    expect(asset?.promptDetail?.promptBody).toBeNull();
    // 元数据还在（条目本身要能被搜到、能被浏览）。
    expect(asset?.promptDetail?.act).toBe("没有 override 的提示词");
    expect(asset?.license).toBe("noassertion");
  });

  it("绕过服务层直接写库：触发器照样清空 promptBody", async () => {
    // 直接用 Prisma 写 Asset（不走 writeAsset）。
    const asset = await prisma.asset.create({
      data: {
        kind: "PROMPT",
        slug: "prompt-tier-bypass-service",
        displayName: "绕过服务层写入的提示词",
        // 未声明许可证 → 触发器推导出 METADATA_ONLY。
        license: null,
        contentBody: "绕过服务层塞进来的原文",
        promptDetail: {
          create: {
            modality: "TEXT",
            act: "绕过服务层写入的提示词",
            promptBody: "绕过服务层塞进来的原文",
          },
        },
      },
      include: { promptDetail: true },
    });

    expect(asset.contentTier).toBe("METADATA_ONLY");
    // 主表正文被主表触发器清空。
    expect(asset.contentBody).toBeNull();
    // ⚠️ 扩展表的正文被**扩展表自己的**触发器清空 ——
    //    这正是「主表触发器管不到 promptBody」那个疑问的答案：
    //    PromptDetail_body_guard 是独立的一条触发器，它确实存在且生效。
    expect(asset.promptDetail?.promptBody).toBeNull();
  });

  it("署名与工具标签是元数据：METADATA_ONLY 档位下也保留", async () => {
    await writeAsset({
      kind: "PROMPT",
      slug: "prompt-tier-attribution",
      displayName: "带署名的提示词",
      license: null,
      contentBody: "不该入库的原文",
      summaryZh: "摘要",
      summarySource: "TEMPLATE",
      repoOwner: "a",
      repoName: "b",
      detail: {
        prompt: {
          modality: "VIDEO",
          act: "带署名的提示词",
          promptBody: "不该入库的原文",
          toolTags: ["seedance"],
          attribution: "A / b — CC BY 4.0 — https://github.com/a/b",
        },
      },
    });

    const asset = await prisma.asset.findUnique({
      where: { slug: "prompt-tier-attribution" },
      include: { promptDetail: true },
    });

    expect(asset?.contentTier).toBe("METADATA_ONLY");
    expect(asset?.promptDetail?.promptBody).toBeNull();
    // ⚠️ 署名**不能**被清空 —— 它是许可证要求的声明，不是「基于原文生成的内容」。
    expect(asset?.promptDetail?.attribution).toBe(
      "A / b — CC BY 4.0 — https://github.com/a/b",
    );
    // 工具标签同理（它是我们的标注，不是上游原文）。
    expect(asset?.promptDetail?.toolTags).toEqual(["seedance"]);
  });

  it("override 的效果是可测的因果链：不 override 就是 METADATA_ONLY", async () => {
    // 与迁移里的种子数据同构：一仓两许可（prompt 内容 CC0 + 源码 MIT）。
    const overrides = [
      override("f/prompts.chat", "cc0-1.0", ["prompts.csv"]),
      override("f/prompts.chat", "mit", []),
    ];

    const withOverride = resolveLicenseOverride(
      overrides,
      "f/prompts.chat",
      "prompts.csv",
      "NOASSERTION",
    );
    const otherFile = resolveLicenseOverride(
      overrides,
      "f/prompts.chat",
      "README.md",
      "NOASSERTION",
    );

    // 同一个仓库：prompt 内容命中文件级 override → FULL；
    // 别的文件落到仓库级 MIT → 也是 FULL；
    // 而如果**根本没有** override，上游的 NOASSERTION → METADATA_ONLY。
    expect(resolveContentTier(withOverride.spdxId)).toBe("FULL");
    expect(resolveContentTier(otherFile.spdxId)).toBe("FULL");

    const noOverrideAtAll = resolveLicenseOverride([], "f/prompts.chat", "prompts.csv", "NOASSERTION");
    expect(resolveContentTier(noOverrideAtAll.spdxId)).toBe("METADATA_ONLY");
  });
});
