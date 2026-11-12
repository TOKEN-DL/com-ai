import Link from "next/link";

/** 运营入口的索引页。 */
export default function OpsPage() {
  return (
    <main>
      <h1>运营</h1>
      <p className="lede">审核链路是「自动关键词过滤 + 用户举报 + 运营抽查」，不做全量预审队列。</p>
      <ul className="asset-list">
        <li>
          <Link href="/ops/comments">运营抽查</Link>
          <span className="asset-meta">按时间浏览近期评论，用于不定期巡查。</span>
        </li>
        <li>
          <Link href="/ops/reports">待处理举报</Link>
          <span className="asset-meta">用户举报的内容在这里处理：成立则隐藏，驳回则保持可见。</span>
        </li>
      </ul>
    </main>
  );
}
