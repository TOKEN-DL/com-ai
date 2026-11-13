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
import { weeklyTrend } from "@/collector/heat";
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

  if (item.metadata.kind === "MCP") {
    // MCP 条目一律 METADATA_ONLY（registry 不声明许可证），所以只讲来源与名称，
    // **不带**上游描述 —— 描述是上游原文，不进可检索字段。
    const name = item.metadata.mcp?.serverName ?? item.title;
    const where = repoOwner && repoName ? `${repoOwner}/${repoName}` : "MCP 官方 registry";
    return `来自 ${where} 的 MCP server「${name}」。站内只保留元数据与结构化声明，正文请前往原仓库查看。`;
  }

  const where = repoOwner && repoName ? `${repoOwner}/${repoName}` : "上游仓库";

  if (item.metadata.kind === "PROMPT") {
    // Prompt 的标题（act）本身就是一句可读的说明，
    // 所以模板简介只讲来源与许可档位，不复述正文（正文在详情页单独展示）。
    const modality = item.metadata.prompt?.modality ?? "TEXT";
    const base = `来自 ${where} 的${MODALITY_LABELS[modality]}提示词「${item.title}」。`;
    if (resolveContentTier(item.metadata.license) === "METADATA_ONLY") {
      return `${base}该上游未声明允许再分发的许可证，站内只保留元数据与链接，正文请前往原仓库查看。`;
    }
    return base;
  }

  const base = `来自 ${where} 的 Skill「${item.title}」。`;

  if (resolveContentTier(item.metadata.license) === "METADATA_ONLY") {
    return `${base}该上游未声明允许再分发的许可证，站内只保留元数据与链接，正文请前往原仓库查看。`;
  }
  return base;
}

/** 模态的展示名（模板简介与页面共用一份）。 */
const MODALITY_LABELS: Record<string, string> = {
  TEXT: "文本",
  IMAGE: "图片",
  VIDEO: "视频",
  MUSIC: "音乐",
};

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

  // Prompt 一律走模板简介，不调模型。
  //
  // 理由：prompt 的标题（act）本身就是一句可读的说明，
  // 而一批 prompt 是**几千条**量级 —— 逐条调模型既慢又贵，
  // 收益却很低。需要中文简介时用批量重跑脚本补（票 #7 那条链路）。
  if (item.metadata.kind === "PROMPT") {
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
  if (item.metadata.kind === "MCP") {
    return toMcpAssetWriteInput(item);
  }
  if (item.metadata.kind === "PROMPT") {
    return toPromptAssetWriteInput(item);
  }
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
    // 近期增速（票 #24）：skills.sh 榜单给的近 8 周周安装量算出来的趋势。
    // 站点地图来源的条目没有趋势序列 → 0。
    trendScore: weeklyTrend(item.metadata.weeklyInstalls),
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
 * Prompt 条目的写入输入。
 *
 * ⚠️ **正文必须逐字**：写入的 `contentBody` 与 `detail.prompt.promptBody`
 *    是**同一个字符串**，不做任何 trim / 规范化 —— 验收标准要求
 *    「一键复制出的提示词原文与来源逐字一致」。
 *
 * ⚠️ METADATA_ONLY 档位（上游没声明可再分发的许可）时，
 *    服务层与数据库触发器都会把 `promptBody` / `contentBody` 清空 ——
 *    站内不复制别人的版权正文，只留元数据与链接。
 */
function toPromptAssetWriteInput(item: RawItem): Parameters<typeof writeAsset>[0] {
  const prompt = item.metadata.prompt;

  return {
    kind: "PROMPT",
    slug: item.slug,
    displayName: item.title,
    license: item.metadata.license,
    contentBody: item.content ?? null,
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
      prompt: {
        modality: prompt?.modality ?? "TEXT",
        act: prompt?.act ?? null,
        promptBody: prompt?.promptBody ?? null,
        forDevs: prompt?.forDevs ?? null,
        contributor: prompt?.contributor ?? null,
        toolTags: prompt?.toolTags ?? [],
        attribution: prompt?.attribution ?? null,
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
 *
 * ## 场景卡片（票 #12）为什么不在这里派生
 *
 * 场景卡片是**派生资产**：入库一个 Skill 会多出一张场景卡片。
 * 把派生塞进这条路径，这条路径的语义就变了
 * （「采到几条就入库几条」变成「采到几条就多出几张卡片」），
 * 依赖这条语义的地方全会对不上。
 *
 * 所以派生是**独立的一条定时任务**（见 `src/collector/collection-tasks.ts`）：
 * 采集跑完之后，它把上一轮之后变过的资产补上卡片；
 * 全量重算用 `pnpm scenarios:derive`。
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
