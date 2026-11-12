/**
 * 采集结果 → 站内资产。
 *
 * **写入只走 {@link writeAsset}**（#3 建好的服务层），不在这里另写一套写入逻辑：
 *   - 许可证 → 内容档位由 {@link resolveContentTier} 唯一决定，本文件不判断许可证；
 *   - METADATA_ONLY 资产的正文由服务层与数据库触发器共同清空，本文件不绕开它。
 *
 * ## 简介怎么来的（票 #7）
 *
 * - **FULL 档**：调 {@link getSummaryGenerator} 生成中文简介（带内容 hash 缓存，
 *   同一份内容重复采集不会重复调模型）。生成失败**不阻断入库** ——
 *   降级成模板初稿，来源标记 `TEMPLATE`。
 * - **METADATA_ONLY 档**：**不调模型**。站内既不复制原文，也不据原文写简介
 *   （spec 决策 6），只留一句模板说明 + 原仓库链接。
 */
import type { Prisma, SummarySource } from "@prisma/client";

import { writeAsset } from "@/lib/asset-writer";
import { resolveContentTier } from "@/lib/license-tier";
import { buildInstallCommands } from "@/lib/skill-install";
import {
  computeContentHash,
  generateSummary,
} from "@/lib/summary-service";
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

/** 一条资产的简介（落库用）。 */
export type IngestSummary = {
  summaryZh: string;
  whenToUse: string | null;
  howToUse: string | null;
  summarySource: SummarySource;
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
  const where = repoOwner && repoName ? `${repoOwner}/${repoName}` : "上游仓库";
  const base = `来自 ${where} 的 Skill「${item.title}」。`;

  if (resolveContentTier(item.metadata.license) === "METADATA_ONLY") {
    return `${base}该上游未声明允许再分发的许可证，站内只保留元数据与链接，正文请前往原仓库查看。`;
  }
  return base;
}

/**
 * 入库前生成简介（票 #7）。
 *
 * METADATA_ONLY 档**不调模型** —— 站内不复制原文，也不据原文写简介。
 * FULL 档走端口（带缓存）；生成失败由 {@link generateSummary} 兜底成模板初稿。
 */
export async function buildIngestSummary(item: RawItem): Promise<IngestSummary> {
  if (resolveContentTier(item.metadata.license) !== "FULL") {
    return {
      summaryZh: buildTemplateSummary(item),
      whenToUse: null,
      howToUse: null,
      summarySource: "TEMPLATE",
    };
  }

  const { draft } = await generateSummary({
    kind: item.metadata.kind,
    displayName: item.title,
    contentBody: item.content ?? null,
    // 内容 hash 是缓存键的一半 —— 同一份内容换个来源也不重复调模型。
    // 哈希的必须是**简介所依据的那段文字**：有正文用正文，没有正文用作者自述。
    contentHash: computeContentHash(item.content ?? item.metadata.description),
    sourceId: item.metadata.sourceId,
    description: item.metadata.description,
    repoOwner: item.metadata.repoOwner,
    repoName: item.metadata.repoName,
    license: item.metadata.license,
  });

  return {
    summaryZh: draft.summaryZh,
    whenToUse: draft.whenToUse,
    howToUse: draft.howToUse,
    summarySource: draft.source,
  };
}

/** 把一个规范化条目转成写入路径的输入。 */
export function toAssetWriteInput(
  item: RawItem,
  summary?: IngestSummary,
): Parameters<typeof writeAsset>[0] {
  const installCmds = buildInstallCommands({
    owner: item.metadata.repoOwner,
    repo: item.metadata.repoName,
    skillName: item.title,
  });

  const resolved = summary ?? {
    summaryZh: buildTemplateSummary(item),
    whenToUse: null,
    howToUse: null,
    summarySource: "TEMPLATE" as SummarySource,
  };

  return {
    kind: item.metadata.kind,
    slug: item.slug,
    displayName: item.title,
    license: item.metadata.license,
    contentBody: item.content ?? null,
    summaryZh: resolved.summaryZh,
    summarySource: resolved.summarySource,
    whenToUse: resolved.whenToUse,
    howToUse: resolved.howToUse,
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
 * 批量入库。
 *
 * 单条失败不阻塞其它条目 —— 与「单源异常不阻塞其它源」是同一条原则。
 */
export async function ingestItems(items: RawItem[]): Promise<IngestReport> {
  const outcomes: IngestOutcome[] = [];

  for (const item of items) {
    try {
      // 简介先生成再入库：生成失败会降级成模板初稿，不会抛错阻断入库。
      const summary = await buildIngestSummary(item);
      await writeAsset(toAssetWriteInput(item, summary));
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
