/**
 * 中文简介的展示片段（票 #7）。
 *
 * ## 为什么单独抽一个组件
 *
 * 「什么时候该用它」与「怎么用起来」必须**分区显示**：
 * 混在一段话里，读者还是得自己猜哪个是哪个 —— 那就等于没回答。
 *
 * 详情页、列表页、搜索结果项三处都要显示这两块，
 * 所以抽一个组件，三处**必然**是同一套结构与同一套文案。
 */
import type { SummarySource } from "@prisma/client";

import { SUMMARY_SOURCE_LABELS } from "@/lib/summary-service";

/** 「何时用 / 怎么用」两栏。 */
export function SummaryUsage({
  whenToUse,
  howToUse,
}: {
  whenToUse: string | null;
  howToUse: string | null;
}) {
  if (!whenToUse && !howToUse) {
    return null;
  }

  return (
    <div className="usage">
      {whenToUse ? (
        <div className="usage-block">
          <span className="usage-label">何时用</span>
          <p>{whenToUse}</p>
        </div>
      ) : null}
      {howToUse ? (
        <div className="usage-block">
          <span className="usage-label">怎么用</span>
          <p>{howToUse}</p>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 简介来源标注。
 *
 * - `LLM` → 「AI 生成，版权归原作者」（spec 约束 2 的硬要求）；
 * - `HUMAN` → 「人工撰写」（人改过，运营一眼能看出来）；
 * - `TEMPLATE` → 「模板生成」（模型没配或调用失败时的降级文案）。
 */
export function SummarySourceNote({ source }: { source: SummarySource | null }) {
  if (!source) {
    return null;
  }

  const label = SUMMARY_SOURCE_LABELS[source];
  if (!label) {
    return null;
  }

  return <p className="note">{label}</p>;
}
