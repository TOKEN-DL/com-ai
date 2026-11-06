/**
 * Next.js instrumentation —— 应用启动时挂上**采集 cron**（票 #6）。
 *
 * ⚠️ 为什么采集 cron 跑在应用容器，而不是定时任务容器：
 *    定时任务容器的镜像里只有打包产物 `dist/worker.mjs`，**没有 node_modules**，
 *    Prisma 的查询引擎跑不起来；而入库必须走唯一写入路径
 *    `src/lib/asset-writer.ts`（Prisma）。采集 cron 因此由应用容器执行，
 *    **调度器实现仍然只有一份**（`src/worker/scheduler.ts`，两边共用），
 *    不存在第二套 cron 逻辑。
 *
 * 每个源一条**独立 cron**（spec 决策 4）：
 *   - `skills.sh:leaderboard` —— 榜单是高频源（热度每天都在变），每天一次；
 *   - `skills.sh:sitemap`     —— 站点地图是低频源（目录变化很慢），每周一次；
 *   - `retention`             —— 三档保留策略，每天一次。
 *
 * 关闭开关：`COLLECTOR_CRON_ENABLED=false`（非生产环境默认不启动）。
 */
export async function register(): Promise<void> {
  // Edge 运行时没有 node-cron 与 Prisma，直接跳过。
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }
  if (process.env.NODE_ENV !== "production") {
    return;
  }
  if (process.env.COLLECTOR_CRON_ENABLED === "false") {
    console.log("[collector] COLLECTOR_CRON_ENABLED=false，不启动采集 cron");
    return;
  }

  // 动态导入：采集管道只依赖 Node 运行时，不要让 Edge 的包带上它们。
  const { startCollectionCron } = await import("@/collector/collection-cron");
  await startCollectionCron();
}
