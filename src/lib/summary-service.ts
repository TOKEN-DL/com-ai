/**
 * 中文简介的**生成、缓存、人工覆盖与批量重跑**（票 #7）。
 *
 * ## 这个文件负责什么
 *
 * 端口（{@link file://./summary-generator.ts}）只管「怎么让模型写出一段初稿」，
 * 这里管的是**围绕它的三件事**：
 *
 * 1. **按内容 hash 缓存** —— 同一份内容重复采集时不重复调模型；
 * 2. **人工覆盖** —— 用户与运营可以改写，改完来源标记为人工，且不被重跑覆盖；
 * 3. **批量重跑** —— 模型或提示词变更后可以重新生成一批简介。
 *
 * ## 缓存键怎么设计的
 *
 * 缓存键 = **内容 hash + 生成器版本**（`${version}:${contentHash}`）。
 *
 * - 只用内容 hash 不够：模型或提示词一改，旧初稿就不该再被复用；
 * - 用「资产 id」更不行：同一份 SKILL.md 被两个仓库收录时，
 *   生成出来的简介应该一样，不该重复调模型 —— 缓存必须与「资产」无关；
 * - 也不用 `AssetVersion.contentHash`：那张表记的是**版本历史**（键是
 *   资产 + 版本），表达不了「同一份内容换个来源也别重复生成」。
 *
 * 所以缓存键只认「**这份内容**」与「**用哪一版生成器**」。
 *
 * ## 什么时候不写缓存
 *
 * **模板降级（TEMPLATE）不写缓存**。模板降级意味着「这次没生成出来」
 * （模型挂了、超时了、返回结构不对）。把它固化下来，
 * 这条资产就会永远停在模板简介上，直到有人手动重跑 ——
 * 一次网络抖动不该换来这种后果。
 */
import { createHash } from "node:crypto";

import type { Prisma, SummarySource } from "@prisma/client";

import { writeGeneratedSummary, writeHumanSummaryOverride } from "@/lib/asset-writer";
import { prisma } from "@/lib/prisma";
import {
  getSummaryGenerator,
  templateSummaryDraft,
  type SummaryDraft,
  type SummaryGenerator,
  type SummaryGeneratorInput,
} from "@/lib/summary-generator";
import { extractSummaryMaterial } from "@/lib/summary-material";

/**
 * 批量重跑要带上的 1:1 详情行（按资产类型取素材用，票 #26）。
 *
 * SKILL 的素材在 frontmatter、PROMPT 的在 modality / toolTags、
 * MCP 的在 serverDescription —— 一张表都带不上就取不到素材。
 */
const REGENERATE_INCLUDE = {
  skillDetail: true,
  promptDetail: true,
  scenarioDetail: true,
  mcpDetail: true,
} satisfies Prisma.AssetInclude;

/** 批量重跑时一条资产的完整形状（带 1:1 详情行）。 */
type RegenerateAsset = Prisma.AssetGetPayload<{ include: typeof REGENERATE_INCLUDE }>;

/**
 * 生成器版本：**模型或提示词一变就把这个值 +1**。
 *
 * 缓存键里带着它，所以改了模型/提示词之后：
 *   - 老缓存自然失效（键对不上）；
 *   - 跑一次 {@link regenerateSummaries} 就会用新版本重新生成。
 *
 * 换句话说，「模型或提示词变更后批量重跑」= 改这个常量 + 跑一次重跑。
 */
export const SUMMARY_GENERATOR_VERSION = "v1";

/** 内容 hash（SHA-256 十六进制）。null / undefined 视为空内容。 */
export function computeContentHash(content: string | null | undefined): string {
  return createHash("sha256").update(content ?? "", "utf8").digest("hex");
}

/**
 * 缓存键 = 生成器版本 + ":" + 内容 hash。
 *
 * 拼成一个字符串是为了「一次唯一索引查找」；
 * 表里另外存了 contentHash / generatorVersion 两列，是为了能按维度查
 * （例如清掉旧版本的缓存行）。
 */
export function buildSummaryCacheKey(
  contentHash: string,
  generatorVersion: string = SUMMARY_GENERATOR_VERSION,
): string {
  return `${generatorVersion}:${contentHash}`;
}

/**
 * 这条资产的简介是不是**人工覆盖**过的。
 *
 * 判定依据只有 `summaryOverriddenAt`：非空 = 人写过 = 批量重跑必须跳过。
 *
 * 为什么不看 `summarySource === "HUMAN"`：用户发布自己的资产时，
 * 来源也会是 HUMAN（那是用户自己写的一句话），但那是**发布**，
 * 不是「纠正 AI 初稿」，不该被当成「覆盖过」。
 */
export function isHumanOverridden(asset: {
  summaryOverriddenAt?: Date | null;
}): boolean {
  return asset.summaryOverriddenAt != null;
}

/** 生成结果。 */
export type SummaryGenerationResult = {
  /// 落库用的初稿。
  draft: SummaryDraft;
  /// 这次是不是**命中了缓存**（true = 没有再调模型）。
  cached: boolean;
};

/** 生成简介（带缓存）。
 *
 * 流程：查缓存 → 命中就直接用；没命中才调生成器 → 成功后写缓存。
 *
 * **失败不抛错**：生成器抛异常 / 返回空简介，一律降级成模板初稿
 * （source = TEMPLATE），调用方照常入库 —— spec 决策 7。
 */
export async function generateSummary(
  input: SummaryGeneratorInput,
  deps: {
    generator?: SummaryGenerator;
    generatorVersion?: string;
    /// 忽略缓存强制重新调模型（批量重跑的逃生舱：模型没换也想重写一遍）。
    ignoreCache?: boolean;
  } = {},
): Promise<SummaryGenerationResult> {
  const generatorVersion = deps.generatorVersion ?? SUMMARY_GENERATOR_VERSION;
  const contentHash = input.contentHash ?? computeContentHash(input.contentBody);
  const cacheKey = buildSummaryCacheKey(contentHash, generatorVersion);

  const cached = deps.ignoreCache
    ? null
    : await prisma.assetSummaryCache.findUnique({ where: { cacheKey } });
  if (cached) {
    return {
      draft: {
        summaryZh: cached.summaryZh,
        whenToUse: cached.whenToUse,
        howToUse: cached.howToUse,
        tags: cached.tags,
        source: cached.source,
      },
      cached: true,
    };
  }

  const draft = await generateDraftSafely(
    { ...input, contentHash },
    deps.generator ?? getSummaryGenerator(),
  );

  // 只缓存**生成成功**的初稿：模板降级是「这次没生成出来」，不该被固化。
  if (draft.source !== "TEMPLATE") {
    await prisma.assetSummaryCache.upsert({
      where: { cacheKey },
      create: {
        cacheKey,
        contentHash,
        generatorVersion,
        summaryZh: draft.summaryZh,
        whenToUse: draft.whenToUse,
        howToUse: draft.howToUse,
        tags: draft.tags,
        source: draft.source,
      },
      update: {
        summaryZh: draft.summaryZh,
        whenToUse: draft.whenToUse,
        howToUse: draft.howToUse,
        tags: draft.tags,
        source: draft.source,
      },
    });
  }

  return { draft, cached: false };
}

/**
 * 调生成器，**任何异常都不外泄** —— 降级成模板初稿。
 *
 * 与端口实现里的降级是两道保险：实现自己也会降级，这里再兜一层，
 * 保证「换成任何实现都不会让入库流程炸掉」。
 */
async function generateDraftSafely(
  input: SummaryGeneratorInput,
  generator: SummaryGenerator,
): Promise<SummaryDraft> {
  try {
    const draft = await generator.generate(input);
    if (!draft || typeof draft.summaryZh !== "string" || draft.summaryZh.trim().length === 0) {
      return templateSummaryDraft(input);
    }
    return draft;
  } catch {
    return templateSummaryDraft(input);
  }
}

/** 人工覆盖的入参。 */
export type OverrideSummaryInput = {
  /// 资产 id。
  assetId: string;
  /// 中文简介（一段话）。
  summaryZh: string;
  /// 「何时用」；null = 清空。
  whenToUse?: string | null;
  /// 「怎么用」；null = 清空。
  howToUse?: string | null;
  /// 覆盖人（userId）。
  operatorId: string | null;
};

/**
 * 人工覆盖一条资产的简介。
 *
 * 覆盖之后：
 *   - 来源标记变成 `HUMAN`（页面显示「人工撰写」）；
 *   - 记下覆盖时间与覆盖人；
 *   - 之后的批量重跑会跳过它（判定依据是 `summaryOverriddenAt`）。
 */
export async function overrideAssetSummary(
  input: OverrideSummaryInput,
): Promise<{ ok: true } | { ok: false; error: "not_found" }> {
  const asset = await prisma.asset.findUnique({
    where: { id: input.assetId },
    select: { id: true },
  });
  if (!asset) {
    return { ok: false, error: "not_found" };
  }

  await writeHumanSummaryOverride({
    assetId: input.assetId,
    summaryZh: input.summaryZh,
    whenToUse: input.whenToUse ?? null,
    howToUse: input.howToUse ?? null,
    operatorId: input.operatorId,
  });

  return { ok: true };
}

/** 批量重跑的入参。 */
export type RegenerateOptions = {
  /// 用哪个生成器版本重跑；默认当前常量。
  generatorVersion?: string;
  /// 只重跑这些 slug；不传 = 全部。
  slugs?: string[];
  /// 是否跳过人工覆盖过的（默认 true —— spec 决策 7 的硬要求）。
  skipOverridden?: boolean;
  /// 忽略缓存强制重新调模型（默认 false）。
  ignoreCache?: boolean;
  /// 最多处理多少条。
  limit?: number;
  /**
   /// 同时处理多少条（默认 1 = 串行）。
   *
   /// 模板路线一轮几千条，串行够用；LLM 路线每条要过一次网络，
   /// 串行会跑成小时级 —— 那时用 `--concurrency` 加快。
   *
   * 计数语义与串行完全一样，只是同时在飞。
   */
  concurrency?: number;
};

/** 批量重跑的统计。 */
export type RegenerateReport = {
  /// 扫到的条数。
  scanned: number;
  /// 真正重新生成的条数。
  regenerated: number;
  /// 命中缓存、没有再调模型的条数。
  cached: number;
  /// 因为人工覆盖过而跳过的条数。
  skippedOverridden: number;
  /// 因为不是 FULL 档（没有原文可依据）而跳过的条数。
  skippedNoContent: number;
  /// 单条失败（已降级，不影响其它条目）的条数。
  failed: number;
};

/**
 * 批量重新生成简介（票 #7）。
 *
 * 入口是**可复用的函数**，不是一次性脚本 ——
 * CLI 脚本、管理接口、定时任务都能调它。
 *
 * 三条硬规矩：
 *   1. **跳过人工覆盖过的**（`summaryOverriddenAt` 非空）——
 *      「用户与运营可以覆盖，且不被批量重跑覆盖」；
 *   2. **只处理 FULL 档** —— METADATA_ONLY 没有原文可依据，
 *      不生成基于原文的简介（spec 决策 6）；
 *   3. **排除场景卡片**（票 #26）—— 卡片是**派生产物**：
 *      它的简介由场景派生逻辑专门写，重跑会把那张派生出来的简介
 *      覆盖成通用模板 —— 那是在抹掉别人的东西。
 *
 * 模型或提示词变更后怎么重跑：把 {@link SUMMARY_GENERATOR_VERSION} +1，
 * 然后调一次这个函数 —— 新版本的缓存键对不上，全部重新生成。
 */
export async function regenerateSummaries(
  options: RegenerateOptions = {},
  deps: { generator?: SummaryGenerator } = {},
): Promise<RegenerateReport> {
  const generatorVersion = options.generatorVersion ?? SUMMARY_GENERATOR_VERSION;
  const skipOverridden = options.skipOverridden ?? true;
  const limit = options.limit ?? 500;

  const assets = await prisma.asset.findMany({
    where: {
      contentTier: "FULL",
      // 场景卡片是派生产物，简介归场景派生逻辑管 —— 批量重跑不碰它。
      kind: { not: "SCENARIO" },
      ...(options.slugs && options.slugs.length > 0 ? { slug: { in: options.slugs } } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: limit,
    include: REGENERATE_INCLUDE,
  });

  const report: RegenerateReport = {
    scanned: assets.length,
    regenerated: 0,
    cached: 0,
    skippedOverridden: 0,
    skippedNoContent: 0,
    failed: 0,
  };

  /** 处理一条。单条失败不影响其它条目 —— 与「单源异常不阻塞其它源」同一条原则。 */
  async function regenerateOne(asset: RegenerateAsset): Promise<void> {
    if (skipOverridden && isHumanOverridden(asset)) {
      report.skippedOverridden += 1;
      return;
    }

    if (!asset.contentBody) {
      report.skippedNoContent += 1;
      return;
    }

    try {
      const result = await generateSummary(buildGeneratorInput(asset), {
        ...(deps.generator ? { generator: deps.generator } : {}),
        generatorVersion,
        ...(options.ignoreCache ? { ignoreCache: true } : {}),
      });

      if (result.cached) {
        report.cached += 1;
      } else {
        report.regenerated += 1;
      }

      await writeGeneratedSummary({
        assetId: asset.id,
        summaryZh: result.draft.summaryZh,
        whenToUse: result.draft.whenToUse,
        howToUse: result.draft.howToUse,
        summarySource: result.draft.source,
      });
    } catch {
      report.failed += 1;
    }
  }

  // 并发：默认 1（串行，语义与从前完全一致）。
  // cursor 的自增发生在 await 之前 —— JS 单线程，同一个 worker 不会取到同一条。
  const requested = options.concurrency ?? 1;
  const concurrency = Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : 1;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, assets.length) }, async () => {
    while (cursor < assets.length) {
      const asset = assets[cursor];
      cursor += 1;
      await regenerateOne(asset);
    }
  });
  await Promise.all(workers);

  return report;
}

/** 从库里的一条资产还原出生成器的入参。 */
function buildGeneratorInput(asset: RegenerateAsset): SummaryGeneratorInput {
  const material = extractSummaryMaterial({
    kind: asset.kind,
    skillDetail: asset.skillDetail,
    promptDetail: asset.promptDetail,
    scenarioDetail: asset.scenarioDetail,
    mcpDetail: asset.mcpDetail,
  });

  return {
    kind: asset.kind,
    displayName: asset.displayName,
    contentBody: asset.contentBody,
    // 与采集、发布两条路径**同一条**哈希规则：哈希简介所依据的那段文字。
    contentHash: computeContentHash(asset.contentBody ?? material.authorNote),
    sourceId: asset.sourceId,
    description: material.authorNote,
    repoOwner: asset.repoOwner,
    repoName: asset.repoName,
    license: asset.license,
    // PROMPT 的模态与目标工具（票 #26）：它们才回答得了「什么时候该用它」。
    modality: material.modality,
    toolTags: material.toolTags,
  };
}

/** 来源标记的展示文案（页面与接口共用一份，避免两处各写一遍）。 */
export const SUMMARY_SOURCE_LABELS: Record<SummarySource, string> = {
  LLM: "AI 生成，版权归原作者",
  HUMAN: "人工撰写",
  TEMPLATE: "模板生成",
};

/** 取来源标记的展示文案。 */
export function summarySourceLabel(source: SummarySource | null | undefined): string | null {
  if (!source) {
    return null;
  }
  return SUMMARY_SOURCE_LABELS[source] ?? null;
}
