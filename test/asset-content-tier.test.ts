/**
 * 许可证分层在**写入路径**上的强制执行（票 #3 验收标准）。
 *
 * 这一组测试专门盯「绕过服务层直接调底层写入」的场景：
 * 全部用 `prisma.*` 直接写库，不经过任何应用层封装，
 * 断言结果与「服务层写入」完全一致 —— 约束落在数据库层，不依赖调用方自觉。
 *
 * 纯函数那一侧见 test/license-tier.test.ts。
 */
import { describe, expect, it } from "vitest";

import { prisma } from "@/lib/prisma";
import { REDISTRIBUTABLE_LICENSES } from "@/lib/license-tier";

const SKILL_BODY = "# My Skill\n\n原始正文，只有允许再分发的许可才能存。";

describe("绕过服务层直接写库 —— 允许再分发的许可", () => {
  it("MIT 许可的资产：档位为 FULL，正文与摘要被保存", async () => {
    const asset = await prisma.asset.create({
      data: {
        kind: "SKILL",
        slug: "direct-mit",
        displayName: "Direct MIT",
        license: "MIT",
        contentBody: SKILL_BODY,
        summaryZh: "这是一个中文简介",
        summarySource: "LLM",
      },
    });

    expect(asset.contentTier).toBe("FULL");
    expect(asset.contentBody).toBe(SKILL_BODY);
    expect(asset.summaryZh).toBe("这是一个中文简介");

    const reread = await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(reread.contentTier).toBe("FULL");
    expect(reread.contentBody).toBe(SKILL_BODY);
  });

  it("Apache-2.0 / CC0-1.0 同样判为 FULL", async () => {
    for (const license of ["Apache-2.0", "cc0-1.0"]) {
      const asset = await prisma.asset.create({
        data: {
          kind: "PROMPT",
          slug: `direct-${license.toLowerCase()}`,
          displayName: `Direct ${license}`,
          license,
          contentBody: "prompt body",
        },
      });
      expect(asset.contentTier).toBe("FULL");
    }
  });
});

describe("绕过服务层直接写库 —— 无许可证 / 未知许可", () => {
  it("无许可证的资产：档位为 METADATA_ONLY，正文不被保存", async () => {
    const asset = await prisma.asset.create({
      data: {
        kind: "SKILL",
        slug: "direct-no-license",
        displayName: "Direct No License",
        license: null,
        contentBody: SKILL_BODY,
      },
    });

    expect(asset.contentTier).toBe("METADATA_ONLY");
    expect(asset.contentBody).toBeNull();

    const reread = await prisma.asset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(reread.contentTier).toBe("METADATA_ONLY");
    expect(reread.contentBody).toBeNull();
  });

  it("即使调用方强行指定 contentTier=FULL，也会被打回 METADATA_ONLY 且正文被清空", async () => {
    const asset = await prisma.asset.create({
      data: {
        kind: "SKILL",
        slug: "direct-forced-full",
        displayName: "Direct Forced Full",
        license: null,
        contentTier: "FULL",
        contentBody: SKILL_BODY,
      },
    });

    expect(asset.contentTier).toBe("METADATA_ONLY");
    expect(asset.contentBody).toBeNull();
  });

  it("未知许可（NOASSERTION）判为 METADATA_ONLY，正文不被保存", async () => {
    const asset = await prisma.asset.create({
      data: {
        kind: "MCP",
        slug: "direct-unknown-license",
        displayName: "Direct Unknown License",
        license: "NOASSERTION",
        contentBody: "mcp readme body",
      },
    });

    expect(asset.contentTier).toBe("METADATA_ONLY");
    expect(asset.contentBody).toBeNull();
  });

  it("METADATA_ONLY 下，基于原文生成的 LLM 简介不保留；人工撰写的保留", async () => {
    const llmSummary = await prisma.asset.create({
      data: {
        kind: "SKILL",
        slug: "direct-llm-summary",
        displayName: "Direct LLM Summary",
        license: null,
        summaryZh: "由原文生成的简介",
        summarySource: "LLM",
      },
    });

    expect(llmSummary.summaryZh).toBeNull();
    expect(llmSummary.summarySource).toBeNull();

    const humanSummary = await prisma.asset.create({
      data: {
        kind: "SKILL",
        slug: "direct-human-summary",
        displayName: "Direct Human Summary",
        license: null,
        summaryZh: "自己写的一句话描述",
        summarySource: "HUMAN",
      },
    });

    expect(humanSummary.summaryZh).toBe("自己写的一句话描述");
    expect(humanSummary.summarySource).toBe("HUMAN");
  });
});

describe("绕过服务层直接写库 —— 扩展表与版本表同样受约束", () => {
  it("METADATA_ONLY 的 Prompt 正文被清空，FULL 的保留", async () => {
    const metadataOnly = await prisma.asset.create({
      data: { kind: "PROMPT", slug: "prompt-metadata", displayName: "Prompt Metadata", license: null },
    });
    await prisma.promptDetail.create({
      data: { assetId: metadataOnly.id, promptBody: "原始提示词正文" },
    });
    const promptDetail = await prisma.promptDetail.findUniqueOrThrow({
      where: { assetId: metadataOnly.id },
    });
    expect(promptDetail.promptBody).toBeNull();

    const full = await prisma.asset.create({
      data: { kind: "PROMPT", slug: "prompt-full", displayName: "Prompt Full", license: "MIT" },
    });
    await prisma.promptDetail.create({
      data: { assetId: full.id, promptBody: "原始提示词正文" },
    });
    const fullDetail = await prisma.promptDetail.findUniqueOrThrow({
      where: { assetId: full.id },
    });
    expect(fullDetail.promptBody).toBe("原始提示词正文");
  });

  it("METADATA_ONLY 的版本快照被清空，FULL 的保留", async () => {
    const metadataOnly = await prisma.asset.create({
      data: { kind: "SKILL", slug: "version-metadata", displayName: "Version Metadata", license: null },
    });
    await prisma.assetVersion.create({
      data: {
        assetId: metadataOnly.id,
        version: "abc1234",
        origin: "UPSTREAM",
        snapshot: SKILL_BODY,
      },
    });
    const version = await prisma.assetVersion.findFirstOrThrow({
      where: { assetId: metadataOnly.id },
    });
    expect(version.snapshot).toBeNull();

    const full = await prisma.asset.create({
      data: { kind: "SKILL", slug: "version-full", displayName: "Version Full", license: "MIT" },
    });
    await prisma.assetVersion.create({
      data: {
        assetId: full.id,
        version: "abc1234",
        origin: "UPSTREAM",
        snapshot: SKILL_BODY,
      },
    });
    const fullVersion = await prisma.assetVersion.findFirstOrThrow({
      where: { assetId: full.id },
    });
    expect(fullVersion.snapshot).toBe(SKILL_BODY);
  });

  it("METADATA_ONLY 的 whenToUse / howToUse 被清空（这两个字段由原文生成）", async () => {
    const metadataOnly = await prisma.asset.create({
      data: { kind: "SKILL", slug: "skill-metadata", displayName: "Skill Metadata", license: null },
    });
    await prisma.skillDetail.create({
      data: {
        assetId: metadataOnly.id,
        whenToUse: "批量处理 PDF 时使用",
        howToUse: "安装后直接调用",
      },
    });
    const detail = await prisma.skillDetail.findUniqueOrThrow({
      where: { assetId: metadataOnly.id },
    });
    expect(detail.whenToUse).toBeNull();
    expect(detail.howToUse).toBeNull();

    const full = await prisma.asset.create({
      data: { kind: "SKILL", slug: "skill-full", displayName: "Skill Full", license: "MIT" },
    });
    await prisma.skillDetail.create({
      data: {
        assetId: full.id,
        whenToUse: "批量处理 PDF 时使用",
        howToUse: "安装后直接调用",
      },
    });
    const fullDetail = await prisma.skillDetail.findUniqueOrThrow({
      where: { assetId: full.id },
    });
    expect(fullDetail.whenToUse).toBe("批量处理 PDF 时使用");
    expect(fullDetail.howToUse).toBe("安装后直接调用");
  });
});

describe("license 字段的归一化", () => {
  it("写入时统一转成小写，空串视为未声明", async () => {
    const asset = await prisma.asset.create({
      data: { kind: "SKILL", slug: "license-case", displayName: "License Case", license: "  MIT  " },
    });
    expect(asset.license).toBe("mit");

    const blank = await prisma.asset.create({
      data: { kind: "SKILL", slug: "license-blank", displayName: "License Blank", license: "   " },
    });
    expect(blank.license).toBeNull();
  });
});

describe("LicensePolicy 表与纯函数白名单一致", () => {
  it("数据库里判为 FULL 的许可与 src/lib/license-tier.ts 的白名单逐字相同", async () => {
    const rows = await prisma.licensePolicy.findMany({
      where: { tier: "FULL" },
      orderBy: { spdxId: "asc" },
    });

    expect(rows.map((row) => row.spdxId)).toEqual([...REDISTRIBUTABLE_LICENSES].sort());
  });
});
