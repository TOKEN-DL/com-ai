import { OpsCommentsPanel } from "./OpsCommentsPanel";

/**
 * 运营抽查页：按时间浏览近期评论。
 *
 * 抽查是**不定期巡查**，不是全量预审队列（spec 决策 11）—— 所以这里给的是
 * 「按时间倒序拉一段出来看」，而不是一个等着人逐条审的待审队列。
 */
export default function OpsCommentsPage() {
  return (
    <main>
      <h1>运营抽查</h1>
      <p className="lede">按时间浏览近期评论，用于不定期巡查。命中关键词过滤的评论会标成「待抽查」。</p>
      <OpsCommentsPanel />
    </main>
  );
}
