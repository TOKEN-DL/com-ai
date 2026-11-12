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
import { Prisma, type Asset, type AssetKind, type DependencyKind, type PromptModality, type SummarySource } from "@prisma/client";

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
  /// registry 里的规范 server 名（reverse-DNS）。
  serverName?: string | null;
  /// registry 给的原始描述。
  serverDescription?: string | null;
  /// 来源仓库最近一次推送的时间。
  repoPushedAt?: Date | null;
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
  /**
   * 工具 / 模型标签（Flux / Seedance / Suno …，票 #15）。
   *
   * 空数组 = 通用提示词。
   */
  toolTags?: string[];
  /**
   * 许可证要求的署名（票 #15）。
   *
   * CC BY 4.0 允许再分发但**必须署名**（作者 + 许可证标识 + 原仓库链接）。
   * ⚠️ 与 `contributor` 是两回事：`contributor` 是「这条提示词是谁贡献的」，
   *    来自上游仓库；`attribution` 是许可证义务，**不能**互相替代。
   *
   * 这一列**不受 METADATA_ONLY 档位清空**：署名是许可证要求的声明，
   * 不是「基于原文生成的内容」。METADATA_ONLY 只清 `promptBody`。
   */
  attribution?: string | null;
};

/**
 * 场景卡片扩展表数据（票 #12）。
 *
 * 卡片与源资产的对应关系：源资产是谁、场景短语是什么、归一化键是什么
 * （归一化键是去重的依据，数据库上有唯一约束兜底）。
 */
export type ScenarioDetailInput = {
  /// 派生出这张卡片的源资产 id。
  sourceAssetId: string;
  /// 源资产的 slug（卡片详情页靠它直达 Skill 详情）。
  sourceAssetSlug: string;
  /// 场景短语原文。
  scenarioText: string;
  /// 场景短语的归一化键。
  scenarioKey: string;
  /// 派生来源：`whenToUse` / `frontmatter`。
  origin: string;
};

/**
 * 类型扩展表数据。与 kind 一一对应：
 * 传了与 kind 不匹配的扩展表会直接报错，避免把 Skill 的字段写进 McpDetail。
 */
export type AssetDetailInput =
  | { skill: SkillDetailInput }
  | { mcp: McpDetailInput }
  | { prompt: PromptDetailInput }
  | { scenario: ScenarioDetailInput };

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
 * 写入事务的时限。
 *
 * ⚠️ Prisma 的交互式事务**默认只给 5 秒**：超时后事务会被关掉，
 *    后面那条语句就报「Transaction already closed」。
 *    MCP 条目要写 packages / remotes / tools / configJson 四个 JSON 字段，
 *    实测在真实库上偶尔会超过 5 秒（600 条里偶发 1~2 条失败）。
 *    这里放宽到 15 秒 —— 只是「最多允许跑多久」，不改变事务语义。
 */
const TRANSACTION_OPTIONS = {
  /// 交互式事务的执行时限（毫秒）。
  timeout: 15_000,
  /// 排队等连接池的超时（毫秒）。
  maxWait: 10_000,
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
  const requestedWhenToUseRaw = input.whenToUse ?? mirrored.whenToUse;
  const requestedHowToUseRaw = input.howToUse ?? mirrored.howToUse;

  // METADATA_ONLY：不落基于原文生成的内容。
  // LLM 生成的简介必然基于原文；人工 / 模板撰写的描述保留。
  const keepSummary =
    allowSourceText || input.summarySource !== "LLM";
  const summaryZh = keepSummary ? (input.summaryZh ?? null) : null;
  const summarySource = keepSummary ? (input.summarySource ?? null) : null;

  // 「何时用 / 怎么用」按 spec 决策 7 同样由原文生成 → METADATA_ONLY 一并清空；
  // 人工撰写（HUMAN）例外：那是人写的，不是原文摘抄。
  const keepUsage = allowSourceText || input.summarySource === "HUMAN";
  const requestedWhenToUse = keepUsage ? requestedWhenToUseRaw : null;
  const requestedHowToUse = keepUsage ? requestedHowToUseRaw : null;

  // 人工覆盖优先：这条简介被人工改写过（summaryOverriddenAt 非空）时，
  // **重新采集也不覆盖它** —— 「生成物必须可被纠正」：
  // 纠正过一次的东西不该被下一轮采集抹掉。
  //
  // 例外：调用方自己写的就是人工来源（HUMAN）→ 以调用方为准
  //（例如发布者重新发布时提交的新简介）。
  //
  // 这一步放在**事务外**：事务里只留必要的写入，别给事务加负担
  //（交互式事务有 5 秒上限，机器一忙就容易踩线）。
  // 真正的保证在数据库触发器里（见迁移 20261106180000）：
  // 触发器在同一次行更新里判定，**没有竞态**。
  const existing = await prisma.asset.findUnique({
    where: { slug: input.slug },
    select: {
      summaryOverriddenAt: true,
      summaryZh: true,
      summarySource: true,
      whenToUse: true,
      howToUse: true,
    },
  });

  const keepHumanOverride =
    existing?.summaryOverriddenAt != null && input.summarySource !== "HUMAN";

  // 最终落库的那一份（主表与扩展表镜像共用，保证两边永远一致）。
  const resolvedSummaryZh = keepHumanOverride ? existing.summaryZh : summaryZh;
  const resolvedSummarySource = keepHumanOverride ? existing.summarySource : summarySource;
  const resolvedWhenToUse = keepHumanOverride ? existing.whenToUse : requestedWhenToUse;
  const resolvedHowToUse = keepHumanOverride ? existing.howToUse : requestedHowToUse;

  const assetData = {
    kind: input.kind,
    slug: input.slug,
    displayName: input.displayName,
    license,
    contentTier,
    contentBody: allowSourceText ? (input.contentBody ?? null) : null,
    summaryZh: resolvedSummaryZh,
    summarySource: resolvedSummarySource,
    whenToUse: resolvedWhenToUse,
    howToUse: resolvedHowToUse,
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

    await writeDetail(tx, asset.id, input.kind, input.detail, allowSourceText, {
      whenToUse: resolvedWhenToUse,
      howToUse: resolvedHowToUse,
    });

    return asset;
  }, TRANSACTION_OPTIONS);
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

/**
 * 一条依赖关系（票 #17）。
 *
 * `kind` 是**被依赖资产的类型**（SKILL / MCP / PROMPT）；
 * `constraint` 是发布者声明的版本约束 —— **只展示，不求解**
 * （spec 决策 1：永久不做依赖自动求解器）。
 */
export type AssetDependencyInput = {
  /// 被依赖资产的 id（`AssetDependency.toId`）。
  toId: string;
  /// 被依赖资产的类型。
  kind: DependencyKind;
  /// 版本约束（可空）。
  constraint?: string | null;
};

/**
 * 用一份新的依赖清单**整体替换**某个资产的依赖关系（票 #17）。
 *
 * ## 为什么是「整体替换」而不是「追加」
 *
 * 清单是发布者对「我依赖了什么」的**完整声明**。重新发布时，
 * 清单里删掉的依赖就该消失 —— 追加式写入会让已经解除的依赖一直留着。
 * 空清单 = 显式声明「我不依赖任何东西」，所以照样要清掉旧关系。
 *
 * ## 为什么在一个事务里
 *
 * 先删后插：中间那一刻依赖关系是空的。放在事务里，外部永远看不到
 * 「删了还没插」的中间状态；失败就整体回滚，旧关系还在。
 */
export async function replaceAssetDependencies(
  fromId: string,
  dependencies: AssetDependencyInput[],
): Promise<void> {
  // 同一个目标可能被声明多次（清单解析会拦，但写入路径自己也要兜住）。
  const unique = new Map<string, AssetDependencyInput>();
  for (const dependency of dependencies) {
    unique.set(`${dependency.toId}:${dependency.kind}`, dependency);
  }

  await prisma.$transaction(async (tx) => {
    await tx.assetDependency.deleteMany({ where: { fromId } });
    if (unique.size > 0) {
      await tx.assetDependency.createMany({
        data: [...unique.values()].map((dependency) => ({
          fromId,
          toId: dependency.toId,
          kind: dependency.kind,
          constraint: dependency.constraint ?? null,
        })),
      });
    }
  });
}

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
      serverName: mcp.serverName ?? null,
      serverDescription: mcp.serverDescription ?? null,
      repoPushedAt: mcp.repoPushedAt ?? null,
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

  if (kind === "SCENARIO") {
    if (!("scenario" in detail)) {
      throw new Error(`detail 与 kind 不匹配：kind=${kind}，detail=${describeDetail(detail)}`);
    }
    await writeScenarioDetail(tx, assetId, detail.scenario);
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
    // 工具 / 模型标签与署名都是**元数据**，不是「基于原文生成的内容」，
    // 所以不受 METADATA_ONLY 档位清空 —— 只有 promptBody 受约束。
    toolTags: prompt.toolTags ?? [],
    attribution: prompt.attribution ?? null,
  };
  await tx.promptDetail.upsert({
    where: { assetId },
    create: { assetId, ...data },
    update: data,
  });
}

/**
 * 写场景卡片的扩展表（票 #12）。
 *
 * 与其它三类一样走 1:1 扩展表 —— 「这张卡片是从哪个资产的哪个场景派生出来的」
 * 记在 `ScenarioDetail` 里，主表那份 `Asset` 只管展示与检索。
 *
 * `scenarioKey` 上有唯一约束（sourceAssetId + scenarioKey），
 * 所以「同一资产 + 同一场景只出现一次」是数据库保证的，不靠调用方自觉。
 */
async function writeScenarioDetail(tx: Tx, assetId: string, detail: ScenarioDetailInput): Promise<void> {
  const data = {
    sourceAssetId: detail.sourceAssetId,
    sourceAssetSlug: detail.sourceAssetSlug,
    scenarioText: detail.scenarioText,
    scenarioKey: detail.scenarioKey,
    origin: detail.origin,
  };

  await tx.scenarioDetail.upsert({
    where: { assetId },
    create: { assetId, ...data },
    update: data,
  });
}

function describeDetail(detail: AssetDetailInput): string {
  return Object.keys(detail).join(",");
}
