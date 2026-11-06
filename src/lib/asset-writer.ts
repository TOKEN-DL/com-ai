/**
 * 资产写入路径（服务层）。
 *
 * 职责：**先判档，再决定存什么**。
 *   - 许可证 → 内容档位：走 {@link resolveContentTier} 这个纯函数（全站唯一入口）。
 *   - METADATA_ONLY 档位不落「基于原文的内容」：正文清空、LLM 简介清空、
 *     扩展表里由原文生成的字段（whenToUse / howToUse / promptBody）清空。
 *
 * ⚠️ 这里的判断是**第一道**防线，不是唯一一道：数据库触发器
 *    （prisma/migrations/*_add_full_data_model/migration.sql）会再兜一遍，
 *    保证「绕过服务层直接写库」得到相同结果。两边的规则必须一致，
 *    一致性由 test/asset-writer.test.ts 与 test/asset-content-tier.test.ts 盯着。
 */
import { Prisma, type Asset, type AssetKind, type PromptModality, type SummarySource } from "@prisma/client";

import { normalizeSpdxId, resolveContentTier } from "@/lib/license-tier";
import { prisma } from "@/lib/prisma";

export type SkillDetailInput = {
  frontmatter?: Prisma.InputJsonValue | null;
  whenToUse?: string | null;
  howToUse?: string | null;
  installCmds?: Prisma.InputJsonValue | null;
  hosts?: string[];
  skillPath?: string | null;
  extraFiles?: Prisma.InputJsonValue | null;
};

export type McpDetailInput = {
  transport?: string | null;
  packages?: Prisma.InputJsonValue | null;
  remotes?: Prisma.InputJsonValue | null;
  tools?: Prisma.InputJsonValue | null;
  envVars?: string[];
  ports?: number[];
  configJson?: Prisma.InputJsonValue | null;
};

export type PromptDetailInput = {
  modality?: PromptModality;
  act?: string | null;
  promptBody?: string | null;
  forDevs?: string | null;
  contributor?: string | null;
};

/**
 * 类型扩展表数据。与 kind 一一对应：
 * 传了与 kind 不匹配的扩展表会直接报错，避免把 Skill 的字段写进 McpDetail。
 */
export type AssetDetailInput =
  | { skill: SkillDetailInput }
  | { mcp: McpDetailInput }
  | { prompt: PromptDetailInput };

export type AssetWriteInput = {
  kind: AssetKind;
  slug: string;
  displayName: string;
  /// SPDX 许可证 id；null / 未声明 → METADATA_ONLY。
  license?: string | null;
  /// 资产正文。只有 FULL 档位会被保存。
  contentBody?: string | null;
  summaryZh?: string | null;
  summarySource?: SummarySource | null;
  repoOwner?: string | null;
  repoName?: string | null;
  repoUrl?: string | null;
  upstreamUrl?: string | null;
  sourceId?: string | null;
  publishedAt?: Date | null;
  lastSyncedAt?: Date | null;
  isOfficial?: boolean;
  /// 当前版本（上游 commit sha，或用户发布的平台 semver）。
  /// 二期（#16 版本管理）用这一列；一期只存不用。
  currentVersion?: string | null;
  stars?: number;
  installs?: number;
  heatScore?: number;
  /// 1:1 类型扩展表。
  detail?: AssetDetailInput;
};

/**
 * 写入（或按 slug 更新）一个资产。
 *
 * 幂等：同一个 slug 重复写入是更新，不会产生第二条记录。
 */
export async function writeAsset(input: AssetWriteInput): Promise<Asset> {
  const license = normalizeSpdxId(input.license);
  const contentTier = resolveContentTier(license);
  const allowSourceText = contentTier === "FULL";

  // METADATA_ONLY：不落基于原文生成的内容。
  // LLM 生成的简介必然基于原文；人工 / 模板撰写的描述保留。
  const keepSummary =
    allowSourceText || input.summarySource !== "LLM";
  const summaryZh = keepSummary ? (input.summaryZh ?? null) : null;
  const summarySource = keepSummary ? (input.summarySource ?? null) : null;

  const assetData = {
    kind: input.kind,
    slug: input.slug,
    displayName: input.displayName,
    license,
    contentTier,
    contentBody: allowSourceText ? (input.contentBody ?? null) : null,
    summaryZh,
    summarySource,
    repoOwner: input.repoOwner ?? null,
    repoName: input.repoName ?? null,
    repoUrl: input.repoUrl ?? null,
    upstreamUrl: input.upstreamUrl ?? null,
    sourceId: input.sourceId ?? null,
    publishedAt: input.publishedAt ?? null,
    lastSyncedAt: input.lastSyncedAt ?? null,
    isOfficial: input.isOfficial ?? false,
    // 不传 = **不动**这一列。
    //
    // 之前这里写的是 `input.currentVersion ?? null`，等于「没传就把版本清空」——
    // 重新采集 / 重新发布一次，版本号就没了。票 #16 之后版本由版本管理那条
    // 链路维护（见 `@/lib/version-store`），这里不该越权改它。
    currentVersion: input.currentVersion,
    stars: input.stars ?? 0,
    installs: input.installs ?? 0,
    heatScore: input.heatScore ?? 0,
    // 重新采集 = 重新变热：清掉归档标记（spec 决策 4 的三档保留策略）。
    // 归档只由保留策略打上，也只由「重新采集」或「又变热」取消。
    archivedAt: null,
  };

  return prisma.$transaction(async (tx) => {
    const asset = await tx.asset.upsert({
      where: { slug: input.slug },
      create: assetData,
      update: assetData,
    });

    await writeDetail(tx, asset.id, input.kind, input.detail, allowSourceText);

    return asset;
  });
}

type Tx = Prisma.TransactionClient;

/**
 * 回写资产内容（票 #16「版本管理与一键更新」）。
 *
 * 只改「跟版本有关的几列」，不碰其它字段 ——
 * 完整写入 {@link writeAsset} 会把没传的字段覆盖成默认值
 * （描述、star、安装数……都会被抹掉），回写场景不能这么干。
 *
 * ## 许可证分层照旧
 *
 * METADATA_ONLY 档位**不回写正文**（`contentBody` 置空），只更新元数据
 * （版本号、正文地址、同步时间）。这与服务层判断、数据库触发器两层一致。
 */
export type AssetContentUpdateInput = {
  /// 资产 slug（站内唯一）。
  slug: string;
  /// 新正文。**不传 = 不动正文**；传了但档位是 METADATA_ONLY → 落库为 null。
  contentBody?: string | null;
  /// 当前版本（上游 commit sha 或平台 semver）。不传 = 不动。
  currentVersion?: string | null;
  /// 资产本体地址（上游换了 commit 之后，链接要指到新版本）。不传 = 不动。
  upstreamUrl?: string | null;
  /// 最近一次同步时间。不传 = 不动。
  lastSyncedAt?: Date | null;
  /**
   * 新的 frontmatter（上游元数据，不是 AI 生成的内容）。
   * 不传 = 不动；传 null = 清空。
   */
  frontmatter?: Prisma.InputJsonValue | null;
};

/** 回写资产内容与版本元数据。返回更新后的资产。 */
export async function updateAssetContent(input: AssetContentUpdateInput): Promise<Asset> {
  const existing = await prisma.asset.findUnique({ where: { slug: input.slug } });
  if (!existing) {
    throw new Error(`资产不存在，无法回写内容：${input.slug}`);
  }

  // 档位判定与 writeAsset 同源：许可证 → 内容档位。
  const contentTier = resolveContentTier(normalizeSpdxId(existing.license));
  const allowSourceText = contentTier === "FULL";

  const data: Prisma.AssetUpdateInput = {};

  if (input.contentBody !== undefined) {
    // METADATA_ONLY：正文一律置空（站内不复制原文）。
    data.contentBody = allowSourceText ? input.contentBody : null;
  }
  if (input.currentVersion !== undefined) {
    data.currentVersion = input.currentVersion;
  }
  if (input.upstreamUrl !== undefined) {
    data.upstreamUrl = input.upstreamUrl;
  }
  if (input.lastSyncedAt !== undefined) {
    data.lastSyncedAt = input.lastSyncedAt;
  }

  const asset = await prisma.asset.update({ where: { id: existing.id }, data });

  // frontmatter 是上游元数据，跟着新正文一起更新。
  if (input.frontmatter !== undefined && asset.kind === "SKILL") {
    await prisma.skillDetail.updateMany({
      where: { assetId: asset.id },
      data: {
        frontmatter:
          input.frontmatter === null ? Prisma.DbNull : (input.frontmatter as Prisma.InputJsonValue),
      },
    });
  }

  return asset;
}

/** 写 1:1 的类型扩展表。扩展表与 kind 不匹配时直接报错。 */
async function writeDetail(
  tx: Tx,
  assetId: string,
  kind: AssetKind,
  detail: AssetDetailInput | undefined,
  allowSourceText: boolean,
): Promise<void> {
  if (!detail) {
    return;
  }

  if (kind === "SKILL") {
    if (!("skill" in detail)) {
      throw new Error(`detail 与 kind 不匹配：kind=${kind}，detail=${describeDetail(detail)}`);
    }
    const skill = detail.skill;
    await tx.skillDetail.upsert({
      where: { assetId },
      create: {
        assetId,
        frontmatter: skill.frontmatter ?? undefined,
        whenToUse: allowSourceText ? (skill.whenToUse ?? null) : null,
        howToUse: allowSourceText ? (skill.howToUse ?? null) : null,
        installCmds: skill.installCmds ?? undefined,
        hosts: skill.hosts ?? [],
        skillPath: skill.skillPath ?? null,
        extraFiles: skill.extraFiles ?? undefined,
      },
      update: {
        frontmatter: skill.frontmatter ?? undefined,
        whenToUse: allowSourceText ? (skill.whenToUse ?? null) : null,
        howToUse: allowSourceText ? (skill.howToUse ?? null) : null,
        installCmds: skill.installCmds ?? undefined,
        hosts: skill.hosts ?? [],
        skillPath: skill.skillPath ?? null,
        extraFiles: skill.extraFiles ?? undefined,
      },
    });
    return;
  }

  if (kind === "MCP") {
    if (!("mcp" in detail)) {
      throw new Error(`detail 与 kind 不匹配：kind=${kind}，detail=${describeDetail(detail)}`);
    }
    const mcp = detail.mcp;
    const data = {
      transport: mcp.transport ?? null,
      packages: mcp.packages ?? undefined,
      remotes: mcp.remotes ?? undefined,
      tools: mcp.tools ?? undefined,
      envVars: mcp.envVars ?? [],
      ports: mcp.ports ?? [],
      configJson: mcp.configJson ?? undefined,
    };
    await tx.mcpDetail.upsert({
      where: { assetId },
      create: { assetId, ...data },
      update: data,
    });
    return;
  }

  if (!("prompt" in detail)) {
    throw new Error(`detail 与 kind 不匹配：kind=${kind}，detail=${describeDetail(detail)}`);
  }
  const prompt = detail.prompt;
  const data = {
    modality: prompt.modality ?? ("TEXT" as PromptModality),
    act: prompt.act ?? null,
    promptBody: allowSourceText ? (prompt.promptBody ?? null) : null,
    forDevs: prompt.forDevs ?? null,
    contributor: prompt.contributor ?? null,
  };
  await tx.promptDetail.upsert({
    where: { assetId },
    create: { assetId, ...data },
    update: data,
  });
}

function describeDetail(detail: AssetDetailInput): string {
  return Object.keys(detail).join(",");
}
