/**
 * Prompt 详情页 / 详情接口共用的视图模型（票 #15）。
 *
 * 与 {@link ./mcp-detail} 里 MCP 的那一套同构：页面与接口读**同一份**视图模型，
 * 所以「页面上显示的」与「接口返回的」天然一致 ——
 * 一键复制要「与来源逐字一致」，这条保证不能靠两边各写一遍再对齐。
 *
 * ## 正文必须逐字
 *
 * `promptBody` 是**来源原文的原始切片**（不 trim、不规范化、不截断），
 * `copyText` 直接就是它 —— 页面上的「一键复制」复制的就是这段字符串本身，
 * 不做任何加工。验收标准「一键复制出的提示词原文与来源逐字一致」由此保证。
 *
 * ## METADATA_ONLY 的条目
 *
 * 上游没声明允许再分发的许可时，`promptBody` 会被服务层与数据库触发器**双双清空**
 * （站内不复制别人的版权正文）。这时 `copyText` 是空串，
 * 页面要明确告诉用户「站内只保留元数据与链接，正文请前往原仓库查看」。
 */
import type { ContentTier, PromptModality, SummarySource } from "@prisma/client";

import { getAssetBySlug } from "@/lib/asset-query";

/** 模态的展示名。 */
export const PROMPT_MODALITY_LABELS: Record<PromptModality, string> = {
  TEXT: "文本",
  IMAGE: "图片",
  VIDEO: "视频",
  MUSIC: "音乐",
};

/** Prompt 详情视图。 */
export type PromptDetailView = {
  slug: string;
  displayName: string;
  /** 模态（文本 / 图片 / 视频 / 音乐）。 */
  modality: PromptModality;
  /** 模态的展示名。 */
  modalityLabel: string;
  /** 动作描述 / 标题（`f/prompts.chat` 的 act 字段）。 */
  act: string | null;
  /**
   * 提示词正文（**逐字原文**）。
   *
   * METADATA_ONLY 档位下是 null —— 站内不复制受限许可的原文。
   */
  promptBody: string | null;
  /** 一键复制用的文本 —— 就是 `promptBody` 本身，不做任何加工。 */
  copyText: string;
  /** 面向开发者的说明。 */
  forDevs: string | null;
  /** 贡献者署名（上游自己声明的「谁贡献的」）。 */
  contributor: string | null;
  /** 工具 / 模型标签（Flux / Seedance / Suno …）。 */
  toolTags: string[];
  /** 许可证要求的署名（CC BY 4.0 之类）。 */
  attribution: string | null;
  license: string | null;
  contentTier: ContentTier;
  summaryZh: string | null;
  summarySource: SummarySource | null;
  repoOwner: string | null;
  repoName: string | null;
  repoUrl: string | null;
  /** 资产本体地址（上游文件的具体位置）。 */
  upstreamUrl: string | null;
  sourceId: string | null;
  stars: number;
  heatScore: number;
  favoriteCount: number;
  likeCount: number;
  publishedAt: Date | null;
  updatedAt: Date;
  lastSyncedAt: Date | null;
};

/**
 * 取一条 prompt 的详情视图。
 *
 * 不是 PROMPT、或不存在，都返回 null。
 */
export async function getPromptDetail(slug: string): Promise<PromptDetailView | null> {
  const asset = await getAssetBySlug(slug);
  if (!asset || asset.kind !== "PROMPT") {
    return null;
  }

  const detail = asset.promptDetail;
  const modality = detail?.modality ?? "TEXT";
  // ⚠️ 逐字：不做 trim。空串也照样传下去（空正文 = 没有正文）。
  const promptBody = detail?.promptBody ?? null;

  return {
    slug: asset.slug,
    displayName: asset.displayName,
    modality,
    modalityLabel: PROMPT_MODALITY_LABELS[modality] ?? modality,
    act: detail?.act ?? null,
    promptBody,
    copyText: promptBody ?? "",
    forDevs: detail?.forDevs ?? null,
    contributor: detail?.contributor ?? null,
    toolTags: detail?.toolTags ?? [],
    attribution: detail?.attribution ?? null,
    license: asset.license,
    contentTier: asset.contentTier,
    summaryZh: asset.summaryZh,
    summarySource: asset.summarySource,
    repoOwner: asset.repoOwner,
    repoName: asset.repoName,
    repoUrl: asset.repoUrl,
    upstreamUrl: asset.upstreamUrl,
    sourceId: asset.sourceId,
    stars: asset.stars,
    heatScore: asset.heatScore,
    favoriteCount: asset.favoriteCount,
    likeCount: asset.likeCount,
    publishedAt: asset.publishedAt,
    updatedAt: asset.updatedAt,
    lastSyncedAt: asset.lastSyncedAt,
  };
}
