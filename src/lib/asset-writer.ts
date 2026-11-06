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
 *
 * ## 「何时用 / 怎么用」存在哪（票 #7）
 *
 * 权威存储是 **Asset 主表**的两列（`Asset.whenToUse` / `Asset.howToUse`）：
 * 搜索结果项也要展示它们，而检索层只查主表。
 * `SkillDetail` 里的同名两列是**镜像**（历史上先有的），
 * 由这里一并写入，两边永远一致（触发器用同一条规则，见迁移
 * 20261106180000_add_summary_override_and_cache）。
 *
 * ## 人工覆盖优先（票 #7）
 *
 * 简介被人工覆盖过（`Asset.summaryOverriddenAt` 非空）时，
 * **重新采集也不覆盖它** —— 「生成物必须可被纠正」：
 * 纠正过一次的东西不该被下一轮采集抹掉。
 */
import type { Asset, AssetKind, Prisma, PromptModality, SummarySource } from "@prisma/client";

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
  /// 「何时用」（票 #7）。与 detail.skill.whenToUse 等价，主表这份是权威值。
  whenToUse?: string | null;
  /// 「怎么用」（票 #7）。与 detail.skill.howToUse 等价，主表这份是权威值。
  howToUse?: string | null;
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

  // 「何时用 / 怎么用」主表与扩展表各有一份：主表是权威值，
  // 扩展表里没给就退回扩展表那份 —— 兼容只填了 detail.skill 的旧调用方。
  const mirrored = readMirroredUsage(input.detail, input.kind);
  const requestedWhenToUse = input.whenToUse ?? mirrored.whenToUse;
  const requestedHowToUse = input.howToUse ?? mirrored.howToUse;

  // METADATA_ONLY：不落基于原文生成的内容。
  // LLM 生成的简介必然基于原文；人工 / 模板撰写的描述保留。
  const keepSummary =
    allowSourceText || input.summarySource !== "LLM";
  const summaryZh = keepSummary ? (input.summaryZh ?? null) : null;
  const summarySource = keepSummary ? (input.summarySource ?? null) : null;

  // 「何时用 / 怎么用」按 spec 决策 7 同样由原文生成 → METADATA_ONLY 一并清空；
  // 人工撰写（HUMAN）例外：那是人写的，不是原文摘抄。
  const keepUsage = allowSourceText || input.summarySource === "HUMAN";
  const whenToUse = keepUsage ? requestedWhenToUse : null;
  const howToUse = keepUsage ? requestedHowToUse : null;

  return prisma.$transaction(async (tx) => {
    // 先看一眼这条资产是不是已经被人工覆盖过 —— 人工覆盖优先于重新采集。
    const existing = await tx.asset.findUnique({
      where: { slug: input.slug },
      select: {
        summaryOverriddenAt: true,
        summaryZh: true,
        summarySource: true,
        whenToUse: true,
        howToUse: true,
      },
    });

    // 人工覆盖过的简介，重新采集**也不覆盖**。
    // 例外：调用方自己写的就是人工来源（HUMAN）→ 以调用方为准
    //（例如发布者重新发布时提交的新简介）。
    const keepHumanOverride =
      existing?.summaryOverriddenAt != null && input.summarySource !== "HUMAN";

    const assetData = {
      kind: input.kind,
      slug: input.slug,
      displayName: input.displayName,
      license,
      contentTier,
      contentBody: allowSourceText ? (input.contentBody ?? null) : null,
      summaryZh: keepHumanOverride ? existing.summaryZh : summaryZh,
      summarySource: keepHumanOverride ? existing.summarySource : summarySource,
      whenToUse: keepHumanOverride ? existing.whenToUse : whenToUse,
      howToUse: keepHumanOverride ? existing.howToUse : howToUse,
      repoOwner: input.repoOwner ?? null,
      repoName: input.repoName ?? null,
      repoUrl: input.repoUrl ?? null,
      upstreamUrl: input.upstreamUrl ?? null,
      sourceId: input.sourceId ?? null,
      publishedAt: input.publishedAt ?? null,
      lastSyncedAt: input.lastSyncedAt ?? null,
      isOfficial: input.isOfficial ?? false,
      currentVersion: input.currentVersion ?? null,
      stars: input.stars ?? 0,
      installs: input.installs ?? 0,
      heatScore: input.heatScore ?? 0,
      // 重新采集 = 重新变热：清掉归档标记（spec 决策 4 的三档保留策略）。
      // 归档只由保留策略打上，也只由「重新采集」或「又变热」取消。
      archivedAt: null,
    };

    const asset = await tx.asset.upsert({
      where: { slug: input.slug },
      create: assetData,
      update: assetData,
    });

    await writeDetail(tx, asset.id, input.kind, input.detail, allowSourceText, {
      whenToUse,
      howToUse,
    });

    return asset;
  });
}

/** 扩展表里那份「何时用 / 怎么用」（只有 SKILL 有）。 */
function readMirroredUsage(
  detail: AssetDetailInput | undefined,
  kind: AssetKind,
): { whenToUse: string | null; howToUse: string | null } {
  if (kind !== "SKILL" || !detail || !("skill" in detail)) {
    return { whenToUse: null, howToUse: null };
  }
  return {
    whenToUse: detail.skill.whenToUse ?? null,
    howToUse: detail.skill.howToUse ?? null,
  };
}

/**
 * 人工覆盖一条资产的简介（票 #7）。
 *
 * 覆盖后：
 *   - `summarySource` 变成 `HUMAN`（页面上显示「人工撰写」）；
 *   - `summaryOverriddenAt` 记下覆盖时间，`summaryOverriddenBy` 记下覆盖人；
 *   - 之后的批量重跑会**跳过**这条（判定依据就是 `summaryOverriddenAt`）。
 *
 * 走的是**部分更新**：不动归档标记、热度、计数等其它字段。
 */
export async function writeHumanSummaryOverride(input: {
  assetId: string;
  summaryZh: string;
  whenToUse: string | null;
  howToUse: string | null;
  /// 覆盖人（userId）；拿不到就记 null。
  operatorId: string | null;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();

  await prisma.$transaction(async (tx) => {
    await tx.asset.update({
      where: { id: input.assetId },
      data: {
        summaryZh: input.summaryZh,
        whenToUse: input.whenToUse,
        howToUse: input.howToUse,
        summarySource: "HUMAN",
        summaryOverriddenAt: now,
        summaryOverriddenBy: input.operatorId,
      },
    });

    // SkillDetail 是主表那两列的镜像 —— 一起写，保证两边一致。
    // updateMany：MCP / Prompt 没有这张表，不该凭空造一行出来。
    await tx.skillDetail.updateMany({
      where: { assetId: input.assetId },
      data: { whenToUse: input.whenToUse, howToUse: input.howToUse },
    });
  });
}

/**
 * 写回一份**生成**出来的简介（批量重跑用）。
 *
 * 与 {@link writeHumanSummaryOverride} 的区别：来源标记由调用方给（LLM / TEMPLATE），
 * 且**不**动 `summaryOverriddenAt` —— 覆盖标记只由人工覆盖路径写。
 */
export async function writeGeneratedSummary(input: {
  assetId: string;
  summaryZh: string;
  whenToUse: string | null;
  howToUse: string | null;
  summarySource: SummarySource;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.asset.update({
      where: { id: input.assetId },
      data: {
        summaryZh: input.summaryZh,
        whenToUse: input.whenToUse,
        howToUse: input.howToUse,
        summarySource: input.summarySource,
      },
    });

    await tx.skillDetail.updateMany({
      where: { assetId: input.assetId },
      data: { whenToUse: input.whenToUse, howToUse: input.howToUse },
    });
  });
}

type Tx = Prisma.TransactionClient;

/** 写 1:1 的类型扩展表。扩展表与 kind 不匹配时直接报错。 */
async function writeDetail(
  tx: Tx,
  assetId: string,
  kind: AssetKind,
  detail: AssetDetailInput | undefined,
  allowSourceText: boolean,
  usage: { whenToUse: string | null; howToUse: string | null },
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
        // 镜像主表那两列（主表是权威值，档位判断已在服务层做过）。
        whenToUse: usage.whenToUse,
        howToUse: usage.howToUse,
        installCmds: skill.installCmds ?? undefined,
        hosts: skill.hosts ?? [],
        skillPath: skill.skillPath ?? null,
        extraFiles: skill.extraFiles ?? undefined,
      },
      update: {
        frontmatter: skill.frontmatter ?? undefined,
        whenToUse: usage.whenToUse,
        howToUse: usage.howToUse,
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
