import { OpsReportsPanel } from "./OpsReportsPanel";

/**
 * 举报处理页：用户举报的内容在这里处理。
 *
 * 状态流转：`OPEN`（待处理）→ `RESOLVED`（举报成立，内容被隐藏）
 * 或 `DISMISSED`（举报不成立，内容保持可见）。
 */
export default function OpsReportsPage() {
  return (
    <main>
      <h1>待处理举报</h1>
      <p className="lede">举报成立则隐藏被举报内容；举报不成立则保持可见。处理与否由运营决定。</p>
      <OpsReportsPanel />
    </main>
  );
}
