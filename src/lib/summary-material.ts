/**
 * 摘要素材提取（票 #26）。
 *
 * ## 为什么需要这个文件
 *
 * 站上 10334 条资产的「何时用 / 怎么用」全为空。根因不是「没跑重跑」，
 * 而是摘要生成器**只从 `skillDetail.frontmatter` 取作者自述** ——
 * PROMPT / MCP 根本不走那张表，素材压根没进生成器。
 *
 * 这里把「按资产类型取素材」抽成一个纯函数：模板路线与 LLM 路线共用同一份
 * 素材，行为一致、可单测，不碰数据库。
 *
 * ## 为什么 PROMPT 不取 act
 *
 * 实测 6348 条 PROMPT 的 `act` **全部等于 `displayName`**（同义反复，零信息量）。
 * 真正有信息量的是 `modality`（TEXT / MUSIC / VIDEO / IMAGE）与 `toolTags`
 * （suno / seedance / chatgpt …）—— 它们才回答得了「什么时候该用它」。
 *
 * ## 为什么 SCENARIO 不取素材
 *
 * 卡片的「何时用」就是 `scenarioText` 本身，由场景派生逻辑（票 #12）管；
 * 卡片的 `summaryZh` 也是派生逻辑专门写的。批量重跑不该碰它们。
 */
import type { AssetKind } from "@prisma/client";

import { readFrontmatterDescription } from "@/lib/scenario-derivation";

/** 提取出来的素材。 */
export type SummaryMaterial = {
  /// 作者自己写的一句自述（原文引用）；没有就是 null。
  authorNote: string | null;
  /// 模态（PROMPT 专有）：TEXT / MUSIC / VIDEO / IMAGE。
  modality: string | null;
  /// 目标工具 / 模型标签（PROMPT 专有）。
  toolTags: string[];
};

/** 提取素材需要的行（都是 1:1 的详情表，取不到就是 null）。 */
export type SummaryMaterialSource = {
  /// 资产类型。
  kind: AssetKind;
  /// Skill 详情（frontmatter）。
  skillDetail?: { frontmatter: unknown } | null;
  /// Prompt 详情。
  promptDetail?: { act: string | null; modality: string; toolTags: string[] } | null;
  /// 场景卡片详情。
  scenarioDetail?: { scenarioText: string | null } | null;
  /// MCP 详情。
  mcpDetail?: { serverDescription: string | null } | null;
};

/** 取一段文字；空白当作没有。 */
function readText(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** 按资产类型取素材。 */
export function extractSummaryMaterial(source: SummaryMaterialSource): SummaryMaterial {
  switch (source.kind) {
    case "SKILL":
      return {
        authorNote: readFrontmatterDescription(source.skillDetail?.frontmatter),
        modality: null,
        toolTags: [],
      };
    case "PROMPT":
      return {
        // `act` 实测恒等于 displayName（同义反复，零信息量）→ 不作作者自述。
        authorNote: null,
        modality: source.promptDetail?.modality ?? null,
        toolTags: source.promptDetail?.toolTags ?? [],
      };
    case "MCP":
      return {
        authorNote: readText(source.mcpDetail?.serverDescription),
        modality: null,
        toolTags: [],
      };
    case "SCENARIO":
      // 卡片的「何时用」就是 scenarioText 本身，归派生逻辑管。
      return { authorNote: null, modality: null, toolTags: [] };
  }
}
