/**
 * 写入路径（服务层）与底层写入的一致性（票 #3 验收标准）。
 *
 * 服务层负责「先判档、再决定存什么」；数据库触发器负责「不管你从哪条路写进来，
 * 结果都一样」。这一组测试盯住两件事：
 *   1. 服务层写入的结果符合许可证分层规则；
 *   2. 服务层写入与绕过服务层直接写库，**结果完全相同**。
 */
import { describe, expect, it } from "vitest";

import { writeAsset } from "@/lib/asset-writer";
import { prisma } from "@/lib/prisma";

const BODY = "# 正文\n\n只有允许再分发的许可才能存。";

describe("服务层写入 —— 允许再分发的许可", () => {
  it("MIT 资产：档位 FULL，正文与摘要被保存", async () => {
    const asset = await writeAsset({
      kind: "SKILL",
      slug: "svc-mit",
      displayName: "Service MIT",
      license: "MIT",
      contentBody: BODY,
      summaryZh: "这是一个中文简介",
      summarySource: "LLM",
    });

    expect(asset.contentTier).toBe("FULL");
    expect(asset.contentBody).toBe(BODY);
    expect(asset.summaryZh).toBe("这是一个中文简介");
  });

  it("CC0 / Apache-2.0 同样判为 FULL", async () => {
    for (const license of ["CC0-1.0", "Apache-2.0"]) {
      const asset = await writeAsset({
        kind: "PROMPT",
        slug: `svc-${license.toLowerCase()}`,
        displayName: `Service ${license}`,
        license,
        contentBody: "prompt body",
      });
      expect(asset.contentTier).toBe("FULL");
    }
  });
});

describe("服务层写入 —— 无许可证 / 未知许可", () => {
  it("无许可证资产：档位 METADATA_ONLY，正文不被保存", async () => {
    const asset = await writeAsset({
      kind: "SKILL",
      slug: "svc-no-license",
      displayName: "Service No License",
      license: null,
      contentBody: BODY,
    });

    expect(asset.contentTier).toBe("METADATA_ONLY");
    expect(asset.contentBody).toBeNull();
  });

  it("未知许可（NOASSERTION）：档位 METADATA_ONLY，正文不被保存", async () => {
    const asset = await writeAsset({
      kind: "MCP",
      slug: "svc-unknown-license",
      displayName: "Service Unknown License",
      license: "NOASSERTION",
      contentBody: "mcp readme body",
    });

    expect(asset.contentTier).toBe("METADATA_ONLY");
    expect(asset.contentBody).toBeNull();
  });

  it("METADATA_ONLY 下基于原文生成的 LLM 简介不保留", async () => {
    const asset = await writeAsset({
      kind: "SKILL",
      slug: "svc-llm-summary",
      displayName: "Service LLM Summary",
      license: null,
      summaryZh: "由原文生成的简介",
      summarySource: "LLM",
    });

    expect(asset.summaryZh).toBeNull();
    expect(asset.summarySource).toBeNull();
  });
});

describe("服务层写入与底层写入结果一致", () => {
  it("同一个 MIT 资产：两条路径落库结果相同", async () => {
    const viaService = await writeAsset({
      kind: "SKILL",
      slug: "same-mit-service",
      displayName: "Same MIT",
      license: "MIT",
      contentBody: BODY,
      summaryZh: "中文简介",
      summarySource: "LLM",
    });

    const direct = await prisma.asset.create({
      data: {
        kind: "SKILL",
        slug: "same-mit-direct",
        displayName: "Same MIT",
        license: "MIT",
        contentBody: BODY,
        summaryZh: "中文简介",
        summarySource: "LLM",
      },
    });

    expect(viaService.contentTier).toBe(direct.contentTier);
    expect(viaService.contentTier).toBe("FULL");
    expect(viaService.contentBody).toBe(direct.contentBody);
    expect(viaService.summaryZh).toBe(direct.summaryZh);
    expect(viaService.license).toBe(direct.license);
  });

  it("同一个无许可证资产：两条路径落库结果相同（正文都没被保存）", async () => {
    const viaService = await writeAsset({
      kind: "SKILL",
      slug: "same-none-service",
      displayName: "Same None",
      license: null,
      contentBody: BODY,
    });

    const direct = await prisma.asset.create({
      data: {
        kind: "SKILL",
        slug: "same-none-direct",
        displayName: "Same None",
        license: null,
        contentBody: BODY,
      },
    });

    expect(viaService.contentTier).toBe(direct.contentTier);
    expect(viaService.contentTier).toBe("METADATA_ONLY");
    expect(viaService.contentBody).toBeNull();
    expect(direct.contentBody).toBeNull();
  });
});

describe("服务层写入类型扩展表", () => {
  it("SKILL 资产同时写入 SkillDetail（1:1）", async () => {
    const asset = await writeAsset({
      kind: "SKILL",
      slug: "svc-skill-detail",
      displayName: "Service Skill Detail",
      license: "MIT",
      contentBody: BODY,
      detail: {
        skill: {
          frontmatter: { name: "svc-skill-detail", description: "demo" },
          whenToUse: "批量处理 PDF 时使用",
          howToUse: "安装后直接调用",
          installCmds: { "claude-code": "npx skills add example" },
          hosts: ["claude-code", "codex"],
          skillPath: "skills/pdf/SKILL.md",
        },
      },
    });

    const detail = await prisma.skillDetail.findUniqueOrThrow({ where: { assetId: asset.id } });
    expect(detail.whenToUse).toBe("批量处理 PDF 时使用");
    expect(detail.hosts).toEqual(["claude-code", "codex"]);
    expect(detail.skillPath).toBe("skills/pdf/SKILL.md");
  });

  it("METADATA_ONLY 资产不落基于原文生成的 SkillDetail 字段", async () => {
    const asset = await writeAsset({
      kind: "SKILL",
      slug: "svc-skill-metadata",
      displayName: "Service Skill Metadata",
      license: null,
      detail: {
        skill: {
          whenToUse: "批量处理 PDF 时使用",
          howToUse: "安装后直接调用",
        },
      },
    });

    const detail = await prisma.skillDetail.findUniqueOrThrow({ where: { assetId: asset.id } });
    expect(detail.whenToUse).toBeNull();
    expect(detail.howToUse).toBeNull();
  });

  it("PROMPT 资产写入 PromptDetail，正文受档位约束", async () => {
    const full = await writeAsset({
      kind: "PROMPT",
      slug: "svc-prompt-full",
      displayName: "Service Prompt Full",
      license: "CC0-1.0",
      detail: { prompt: { modality: "TEXT", act: "写文案", promptBody: "原始提示词" } },
    });
    const fullDetail = await prisma.promptDetail.findUniqueOrThrow({ where: { assetId: full.id } });
    expect(fullDetail.promptBody).toBe("原始提示词");

    const metadataOnly = await writeAsset({
      kind: "PROMPT",
      slug: "svc-prompt-metadata",
      displayName: "Service Prompt Metadata",
      license: null,
      detail: { prompt: { modality: "TEXT", act: "写文案", promptBody: "原始提示词" } },
    });
    const metadataDetail = await prisma.promptDetail.findUniqueOrThrow({
      where: { assetId: metadataOnly.id },
    });
    expect(metadataDetail.promptBody).toBeNull();
  });

  it("MCP 资产写入 McpDetail", async () => {
    const asset = await writeAsset({
      kind: "MCP",
      slug: "svc-mcp-detail",
      displayName: "Service MCP Detail",
      license: "MIT",
      detail: {
        mcp: {
          transport: "stdio",
          envVars: ["API_KEY"],
          ports: [3000],
          tools: [{ name: "search", description: "搜索" }],
        },
      },
    });

    const detail = await prisma.mcpDetail.findUniqueOrThrow({ where: { assetId: asset.id } });
    expect(detail.transport).toBe("stdio");
    expect(detail.envVars).toEqual(["API_KEY"]);
    expect(detail.ports).toEqual([3000]);
  });

  it("扩展表与资产 kind 不匹配时报错", async () => {
    await expect(
      writeAsset({
        kind: "SKILL",
        slug: "svc-mismatch",
        displayName: "Service Mismatch",
        license: "MIT",
        detail: { mcp: { transport: "stdio" } },
      }),
    ).rejects.toThrow(/kind/);
  });
});

describe("服务层写入是幂等的", () => {
  it("同一个 slug 再次写入是更新而不是新建", async () => {
    await writeAsset({
      kind: "SKILL",
      slug: "svc-upsert",
      displayName: "Service Upsert v1",
      license: "MIT",
      contentBody: "v1 body",
    });

    const updated = await writeAsset({
      kind: "SKILL",
      slug: "svc-upsert",
      displayName: "Service Upsert v2",
      license: "MIT",
      contentBody: "v2 body",
    });

    expect(await prisma.asset.count({ where: { slug: "svc-upsert" } })).toBe(1);
    expect(updated.displayName).toBe("Service Upsert v2");
    expect(updated.contentBody).toBe("v2 body");
  });
});
