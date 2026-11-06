import { checkDatabase } from "@/lib/db-status";

// 首页要实时显示数据库连通状态，不许被静态化。
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const database = await checkDatabase();

  return (
    <main>
      <h1>com-ai</h1>
      <p className="lede">面向中文 AI 开发者的 Agent 资产市场 —— 环境已就绪。</p>

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
        </dl>

        {database.error ? (
          <p className="bad">连接失败：{database.error}</p>
        ) : null}
      </section>
    </main>
  );
}
