import Link from "next/link";

import { checkDatabase } from "@/lib/db-status";
import { getSearchService, type SearchHit } from "@/lib/search-service";
import { formatTrend, TREND_LABEL } from "@/lib/trend";

// 首页要实时显示数据库连通状态与榜单，不许被静态化。
export const dynamic = "force-dynamic";

/** 榜单条数。 */
const BOARD_SIZE = 10;

/** 一个榜单：条目 + 可比总数。 */
type Board = {
  items: SearchHit[];
  total: number;
};

/**
 * 取两张榜单（spec 故事 13「全站最受欢迎的技能榜单」+ 故事 14「近期增长最快的技能」）。
 *
 * ## 只排 Skill
 *
 * spec 决策 5 的三个热度视图是 **Skill 管道** 的定义，故事 13 / 14 也在
 * 「Skill 库」那一节 —— 所以榜单只取 `kind = SKILL`。
 * MCP / Prompt 没有安装量口径（`installs` 恒为 0），混进来只会拿一堆 0 凑数。
 *
 * ## 读不出来时不炸
 *
 * 数据库没连上时，首页照常显示「环境状态 · 未连通」——
 * 榜单读不出来是**另一件事**，不该让整页 500。
 */
async function loadBoards(): Promise<{ popular: Board; trending: Board } | null> {
  try {
    const search = getSearchService();
    const [popular, trending] = await Promise.all([
      search.search({
        q: "",
        filters: { kind: ["SKILL"] },
        sort: "installs",
        pageSize: BOARD_SIZE,
      }),
      search.search({
        q: "",
        filters: { kind: ["SKILL"] },
        sort: "trending",
        pageSize: BOARD_SIZE,
      }),
    ]);
    return {
      popular: { items: popular.items, total: popular.total },
      trending: { items: trending.items, total: trending.total },
    };
  } catch {
    return null;
  }
}

export default async function HomePage() {
  const database = await checkDatabase();
  const boards = await loadBoards();

  // 一个都没有增速数据时，这个榜是「按热度凑出来的」—— 说清楚比装得像强。
  const hasTrend = boards?.trending.items.some((item) => item.trendScore !== 0) ?? false;

  return (
    <main>
      <h1>com-ai</h1>
      <p className="lede">面向中文 AI 开发者的 Agent 资产市场。</p>

      {boards ? (
        <>
          <section className="board">
            <h2>全站最受欢迎的 Skill</h2>
            <p className="board-note">
              按累计安装量排序（all-time 视图）—— 共收录 {boards.popular.total} 个 Skill，
              下面是安装量前 {boards.popular.items.length} 名。
            </p>
            {boards.popular.items.length > 0 ? (
              <ol className="board-list">
                {boards.popular.items.map((item) => (
                  <li key={item.id}>
                    <Link href={`/skills/${item.slug}`}>{item.displayName}</Link>
                    <span className="asset-meta">
                      {item.repoOwner && item.repoName ? `${item.repoOwner}/${item.repoName}` : ""}
                      {item.installs > 0 ? ` · 安装 ${item.installs}` : ""}
                      {` · 热度 ${item.heatScore}`}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="badge-muted">还没有收录任何 Skill。</p>
            )}
            <p className="board-more">
              <Link href="/skills?sort=installs">看完整榜单 →</Link>
            </p>
          </section>

          <section className="board">
            <h2>近期增长最快的 Skill</h2>
            <p className="board-note">
              按近期增速排序（trending 视图）—— 比的是最近 4 周的周安装量与前 4 周的差。
            </p>
            {boards.trending.items.length > 0 && hasTrend ? (
              <ol className="board-list">
                {boards.trending.items.map((item) => (
                  <li key={item.id}>
                    <Link href={`/skills/${item.slug}`}>{item.displayName}</Link>
                    <span className="asset-meta">
                      {item.repoOwner && item.repoName ? `${item.repoOwner}/${item.repoName}` : ""}
                      {` · ${TREND_LABEL} ${formatTrend(item.trendScore)}`}
                      {item.installs > 0 ? ` · 安装 ${item.installs}` : ""}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="badge-muted">
                {boards.trending.items.length === 0
                  ? "还没有收录任何 Skill。"
                  : "增速数据还没有采到 —— 采集器跑一轮就有了。"}
              </p>
            )}
            <p className="board-more">
              <Link href="/skills?sort=trending">看完整榜单 →</Link>
            </p>
          </section>
        </>
      ) : (
        <p className="badge-muted">榜单暂时读不出来（数据库未连通）。</p>
      )}

      <section className="status">
        <h2>环境状态</h2>
        <dl>
          <dt>Postgres</dt>
          <dd>
            {database.ok ? (
              <span className="ok">已连通</span>
            ) : (
              <span className="bad">未连通</span>
            )}
          </dd>

          <dt>探测耗时</dt>
          <dd>{database.latencyMs === null ? "—" : `${database.latencyMs} ms`}</dd>

          <dt>健康检查</dt>
          <dd>
            <code>/api/health</code>
          </dd>

          <dt>Skill 库</dt>
          <dd>
            <Link href="/skills">浏览已收录的 Skill</Link>
          </dd>

          <dt>MCP 库</dt>
          <dd>
            <Link href="/mcp">浏览已收录的 MCP server</Link>
          </dd>

          <dt>Prompt 库</dt>
          <dd>
            <Link href="/prompts">浏览按模态收录的提示词</Link>
          </dd>

          <dt>场景卡片</dt>
          <dd>
            <Link href="/scenarios">「想做 X 就用这个」—— 按使用场景找 Skill</Link>
          </dd>

          <dt>搜索</dt>
          <dd>
            <Link href="/search">按关键词找 Skill</Link>
          </dd>

          <dt>我的收藏</dt>
          <dd>
            <Link href="/favorites">看看收藏了什么（不用注册也能用）</Link>
          </dd>
        </dl>

        {database.error ? <p className="bad">连接失败：{database.error}</p> : null}
      </section>
    </main>
  );
}
