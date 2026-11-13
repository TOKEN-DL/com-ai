/**
 * 近期增速的展示格式化（票 #24）。
 *
 * `Asset.trendScore` 存的是 `weeklyTrend` 的派生分：[-1, 1]，含义是
 * 「最近一半的周安装量比更早一半多了多少」，夹在 ±100%。
 *
 * 所以 0.5 就是「最近 4 周的周安装量比前 4 周多了 50%」——
 * 乘 100 当百分比展示是**如实**的，不是编出来的增长率。
 */

/** 近期增速这一列的展示名。 */
export const TREND_LABEL = "近期增速";

/**
 * 把 [-1, 1] 的增速分格式化成给人看的字符串。
 *
 * 0 返回「—」：0 有两种含义 —— 真的持平，或者**根本没有趋势数据**
 * （样本不足 4 周）。两种都不该被说成「持平」。
 */
export function formatTrend(trendScore: number): string {
  if (!Number.isFinite(trendScore) || trendScore === 0) {
    return "—";
  }
  const percent = Math.round(trendScore * 100);
  return percent > 0 ? `+${percent}%` : `${percent}%`;
}
