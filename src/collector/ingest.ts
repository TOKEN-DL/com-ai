/**
 * 采集结果 → 站内资产。
 *
 * **写入只走 {@link writeAsset}**（#3 建好的服务层），不在这里另写一套写入逻辑：
 *   - 许可证 → 内容档位由 {@link resolveContentTier} 唯一决定，本文件不判断许可证；
 *   - METADATA_ONLY 资产的正文由服务层与数据库触发器共同清空，本文件不绕开它。
 *
 * 摘要用**模板**生成（`summarySource = "TEMPLATE"`）：LLM 简介是 #7 的活，
 * 现在先用一句模板把「中文简介」这个位置占住，且不引用上游原文
 * ——METADATA_ONLY 档位下更不能把原文塞进摘要。
 */
import type { Prisma } from "@prisma/client";

import { writeAsset } from "@/lib/asset-writer";
import { resolveContentTier } from "@/lib/license-tier";
import { buildInstallCommands } from "@/lib/skill-install";
import type { RawItem } from "@/collector/types";

export type IngestOutcome = {
  slug: string;
  ok: boolean;
  error?: string;
};

export type IngestReport = {
  outcomes: IngestOutcome[];
  /// 成功写入（幂等更新也算成功）的条数。
  written: number;
  failed: number;
};

/**
 * 模板简介（一句话中文）。
 *
 * - FULL 档位：说明来源与名称，不复制上游原文（原文在详情页单独展示）。
 * - METADATA_ONLY 档位：额外说明「站内只保留元数据与链接」，并**不提**上游描述，
 *   避免把受版权保护的原文带进站内可检索字段。
 */
export function buildTemplateSummary(item: RawItem): string {
  const { repoOwner, repoName } = item.metadata;

  if (item.metadata.kind === "MCP") {
    // MCP 条目一律 METADATA_ONLY（registry 不声明许可证），所以只讲来源与名称，
    // **不带**上游描述 —— 描述是上游原文，不进可检索字段。
    const name = item.metadata.mcp?.serverName ?? item.title;
    const where = repoOwner && repoName ? `${repoOwner}/${repoName}` : "MCP 官方 registry";
    return `来自 ${where} 的 MCP server「${name}」。站内只保留元数据与结构化声明，正文请前往原仓库查看。`;
  }

  const where = repoOwner && repoName ? `${repoOwner}/${repoName}` : "上游仓库";
  const base = `来自 ${where} 的 Skill「${item.title}」。`;

  if (resolveContentTier(item.metadata.license) === "METADATA_ONLY") {
    return `${base}该上游未声明允许再分发的许可证，站内只保留元数据与链接，正文请前往原仓库查看。`;
  }
  return base;
}

/** 把一个规范化条目转成写入路径的输入。 */
export function toAssetWriteInput(item: RawItem): Parameters<typeof writeAsset>[0] {
  if (item.metadata.kind === "MCP") {
    return toMcpAssetWriteInput(item);
  }

  const installCmds = buildInstallCommands({
    owner: item.metadata.repoOwner,
    repo: item.metadata.repoName,
    skillName: item.title,
  });

  return {
    kind: item.metadata.kind,
    slug: item.slug,
    displayName: item.title,
    license: item.metadata.license,
    contentBody: item.content ?? null,
    summaryZh: buildTemplateSummary(item),
    summarySource: "TEMPLATE",
    repoOwner: item.metadata.repoOwner,
    repoName: item.metadata.repoName,
    repoUrl: item.metadata.repoUrl,
    upstreamUrl: item.metadata.upstreamUrl,
    sourceId: item.metadata.sourceId,
    publishedAt: item.publishedAt ?? null,
    lastSyncedAt: new Date(),
    isOfficial: item.metadata.isOfficial,
    stars: item.metadata.stars,
    installs: item.metadata.installs,
    heatScore: item.metadata.heatScore,
    detail: {
      skill: {
        frontmatter: item.metadata.frontmatter as Prisma.InputJsonValue,
        installCmds: installCmds as Prisma.InputJsonValue,
        hosts: Object.keys(installCmds),
        skillPath: item.metadata.skillPath,
        extraFiles: item.metadata.extraFiles as unknown as Prisma.InputJsonValue,
      },
    },
  };
}

/**
 * MCP 条目的写入输入。
 *
 * ⚠️ 扩展表里的字段（工具定义 / 环境变量 / 传输方式 / 配置片段）**不是**「基于原文
 *    生成的内容」，所以不受 METADATA_ONLY 档位清空 `contentBody` 的影响 ——
 *    结构化声明照常存，站内也照常展示。
 */
function toMcpAssetWriteInput(item: RawItem): Parameters<typeof writeAsset>[0] {
  const mcp = item.metadata.mcp;

  return {
    kind: "MCP",
    slug: item.slug,
    displayName: item.title,
    license: item.metadata.license,
    // MCP 的「正文」是 server 自己的 README / 源码，站内不取。
    contentBody: null,
    summaryZh: buildTemplateSummary(item),
    summarySource: "TEMPLATE",
    repoOwner: item.metadata.repoOwner || null,
    repoName: item.metadata.repoName || null,
    repoUrl: item.metadata.repoUrl || null,
    upstreamUrl: item.metadata.upstreamUrl,
    sourceId: item.metadata.sourceId,
    publishedAt: item.publishedAt ?? null,
    lastSyncedAt: new Date(),
    isOfficial: item.metadata.isOfficial,
    stars: item.metadata.stars,
    installs: item.metadata.installs,
    heatScore: item.metadata.heatScore,
    detail: {
      mcp: {
        transport: mcp?.transport ?? null,
        serverName: mcp?.serverName ?? null,
        serverDescription: mcp?.serverDescription ?? null,
        repoPushedAt: mcp?.repoPushedAt ?? null,
        packages: (mcp?.packages ?? []) as unknown as Prisma.InputJsonValue,
        remotes: (mcp?.remotes ?? []) as unknown as Prisma.InputJsonValue,
        tools: mcp?.tools ? (mcp.tools as unknown as Prisma.InputJsonValue) : undefined,
        envVars: (mcp?.envVars ?? []).map((variable) => variable.name),
        ports: mcp?.ports ?? [],
        configJson: (mcp?.config ?? {}) as unknown as Prisma.InputJsonValue,
      },
    },
  };
}

/**
 * 批量入库。
 *
 * 单条失败不阻塞其它条目 —— 与「单源异常不阻塞其它源」是同一条原则。
 */
export async function ingestItems(items: RawItem[]): Promise<IngestReport> {
  const outcomes: IngestOutcome[] = [];

  for (const item of items) {
    try {
      await writeAsset(toAssetWriteInput(item));
      outcomes.push({ slug: item.slug, ok: true });
    } catch (error) {
      outcomes.push({
        slug: item.slug,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const written = outcomes.filter((outcome) => outcome.ok).length;
  return { outcomes, written, failed: outcomes.length - written };
}
