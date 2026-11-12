/**
 * 场景卡片详情页 / 详情接口共用的视图模型（票 #12）。
 *
 * 与 {@link ./mcp-detail} 同构：页面与接口读**同一份**视图模型，
 * 所以「页面上显示的」与「接口返回的」天然一致。
 *
 * ## 卡片与 Skill 的关系
 *
 * 卡片是**派生**出来的：它的场景短语来自源资产的「何时用」或 frontmatter 自述。
 * 所以详情页要同时给出两样东西：
 *   - **场景**：这张卡片讲的是「什么时候用」；
 *   - **直达的 Skill**：点一下就跳到源资产的详情页。
 */
import type { AssetKind, SummarySource } from "@prisma/client";

import { prisma } from "@/lib/prisma";

/** 场景派生来源的展示名。 */
export const SCENARIO_ORIGIN_LABELS: Record<string, string> = {
  whenToUse: "「何时用」",
  frontmatter: "上游自述",
};

/** 场景卡片详情视图。 */
export type ScenarioDetailView = {
  /// 卡片自己的 slug。
  slug: string;
  /// 场景短语（卡片标题）。
  displayName: string;
  /// 场景描述（来源文字，截断过）。
  summaryZh: string | null;
  /**
   * 场景描述的来源标记。
   *
   * 页据此标注「AI 生成，版权归原作者」（spec 约束 2 的硬要求）——
   * 场景短语可能来自 LLM 生成的「何时用」，也可能来自上游作者自述，
   * 两者必须分开标注，不能一律当成「模板生成」。
   */
  summarySource: SummarySource | null;
  /// 场景短语原文。
  scenarioText: string;
  /// 场景短语的归一化键（去重用）。
  scenarioKey: string;
  /// 派生来源标识。
  origin: string;
  /// 派生来源的展示名。
  originLabel: string;
  /// 卡片的站内更新时间。
  updatedAt: Date;
  /// 源资产（被派生出这张卡片的 Skill）。源资产没了就是 null。
  source: {
    assetId: string;
    slug: string;
    displayName: string;
    /// 源资产的类型（详情页链接按它分派）。
    kind: AssetKind;
    summaryZh: string | null;
    repoOwner: string | null;
    repoName: string | null;
    repoUrl: string | null;
    license: string | null;
    stars: number;
    installs: number;
    heatScore: number;
  } | null;
};

/**
 * 取一张场景卡片的详情视图。
 *
 * 不是场景卡片、或不存在，都返回 null。
 */
export async function getScenarioDetail(slug: string): Promise<ScenarioDetailView | null> {
  const asset = await prisma.asset.findFirst({
    where: { slug, kind: "SCENARIO", archivedAt: null },
    include: {
      scenarioDetail: {
        include: {
          sourceAsset: {
            select: {
              id: true,
              slug: true,
              displayName: true,
              kind: true,
              summaryZh: true,
              repoOwner: true,
              repoName: true,
              repoUrl: true,
              license: true,
              stars: true,
              installs: true,
              heatScore: true,
            },
          },
        },
      },
    },
  });

  if (!asset || !asset.scenarioDetail) {
    return null;
  }

  const detail = asset.scenarioDetail;

  return {
    slug: asset.slug,
    displayName: asset.displayName,
    summaryZh: asset.summaryZh,
    summarySource: asset.summarySource,
    scenarioText: detail.scenarioText,
    scenarioKey: detail.scenarioKey,
    origin: detail.origin,
    originLabel: SCENARIO_ORIGIN_LABELS[detail.origin] ?? detail.origin,
    updatedAt: asset.updatedAt,
    source: {
      assetId: detail.sourceAsset.id,
      slug: detail.sourceAsset.slug,
      displayName: detail.sourceAsset.displayName,
      kind: detail.sourceAsset.kind,
      summaryZh: detail.sourceAsset.summaryZh,
      repoOwner: detail.sourceAsset.repoOwner,
      repoName: detail.sourceAsset.repoName,
      repoUrl: detail.sourceAsset.repoUrl,
      license: detail.sourceAsset.license,
      stars: detail.sourceAsset.stars,
      installs: detail.sourceAsset.installs,
      heatScore: detail.sourceAsset.heatScore,
    },
  };
}
