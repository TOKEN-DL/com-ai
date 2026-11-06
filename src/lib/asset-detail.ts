/**
 * Skill 详情页 / 详情接口共用的视图模型。
 *
 * 页面与 API 路由**读同一份视图模型**，所以「页面上显示的」与
 * 「接口返回的」天然一致 —— 一键复制要「与原文逐字一致」，
 * 这条保证不能靠两边各写一遍再对齐。
 */
import type { ContentTier, SummarySource } from "@prisma/client";

import { getAssetBySlug } from "@/lib/asset-query";
import { SKILL_HOSTS } from "@/lib/skill-install";

export type InstallCommand = {
  /// 宿主标识。
  host: string;
  /// 宿主展示名。
  label: string;
  /// 该宿主的项目级安装目录。
  path: string;
  /// 可复制的安装命令。
  command: string;
};

export type ExtraFileView = {
  path: string;
  size: number | null;
};

export type SkillDetailView = {
  slug: string;
  /// 英文原文名。
  displayName: string;
  /// 中文简介（现在是模板生成，#7 之后由 LLM 覆盖）。
  summaryZh: string | null;
  summarySource: SummarySource | null;
  /// 原始描述（frontmatter.description，原文不翻译）。
  description: string | null;
  /// SPDX 许可证标识。
  license: string | null;
  /// 内容档位。
  contentTier: ContentTier;
  repoOwner: string | null;
  repoName: string | null;
  /// 来源仓库链接。
  repoUrl: string | null;
  /// 原始 SKILL.md 地址。
  upstreamUrl: string | null;
  stars: number;
  installs: number;
  /// 热度位（现在可以是 0）。
  heatScore: number;
  sourceId: string | null;
  skillPath: string | null;
  frontmatter: Record<string, unknown> | null;
  extraFiles: ExtraFileView[];
  /// 收藏数（跨 kind 统一计数，由数据库触发器维护）。
  favoriteCount: number;
  /// 点赞数（跨 kind 统一计数，由数据库触发器维护）。
  likeCount: number;
  /// 按宿主划分的安装命令。
  installCmds: InstallCommand[];
  /// 站内是否提供正文全文。
  ///
  /// METADATA_ONLY 档位由数据库触发器强制清空 contentBody —— 站内**不复制原文**，
  /// 只给原仓库链接。这是设计如此，不是 bug。
  contentAvailable: boolean;
  /// 原始 SKILL.md 全文（逐字，与上游一致）。仅 contentAvailable 为真时有值。
  contentBody: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asExtraFiles(value: unknown): ExtraFileView[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .map((entry) => ({
      path: typeof entry.path === "string" ? entry.path : "",
      size: typeof entry.size === "number" ? entry.size : null,
    }))
    .filter((entry) => entry.path.length > 0);
}

function asInstallCommands(value: unknown): InstallCommand[] {
  const stored = asRecord(value);
  if (!stored) {
    return [];
  }
  const commands: InstallCommand[] = [];
  for (const [host, command] of Object.entries(stored)) {
    if (typeof command !== "string") {
      continue;
    }
    const meta = SKILL_HOSTS.find((entry) => entry.host === host);
    commands.push({
      host,
      label: meta?.label ?? host,
      path: meta?.path ?? "",
      command,
    });
  }
  return commands;
}

/**
 * 取一个 Skill 的详情视图。
 *
 * 不是 Skill、或不存在，都返回 null。
 */
export async function getSkillDetail(slug: string): Promise<SkillDetailView | null> {
  const asset = await getAssetBySlug(slug);
  if (!asset || asset.kind !== "SKILL") {
    return null;
  }

  const detail = asset.skillDetail;
  const frontmatter = asRecord(detail?.frontmatter);
  const description =
    frontmatter && typeof frontmatter.description === "string"
      ? frontmatter.description
      : null;

  const contentBody = asset.contentBody;
  const contentAvailable = asset.contentTier === "FULL" && typeof contentBody === "string";

  return {
    slug: asset.slug,
    displayName: asset.displayName,
    summaryZh: asset.summaryZh,
    summarySource: asset.summarySource,
    description,
    license: asset.license,
    contentTier: asset.contentTier,
    repoOwner: asset.repoOwner,
    repoName: asset.repoName,
    repoUrl: asset.repoUrl,
    upstreamUrl: asset.upstreamUrl,
    stars: asset.stars,
    installs: asset.installs,
    heatScore: asset.heatScore,
    sourceId: asset.sourceId,
    skillPath: detail?.skillPath ?? null,
    frontmatter,
    extraFiles: asExtraFiles(detail?.extraFiles),
    favoriteCount: asset.favoriteCount,
    likeCount: asset.likeCount,
    installCmds: asInstallCommands(detail?.installCmds),
    contentAvailable,
    contentBody: contentAvailable ? contentBody : null,
  };
}
