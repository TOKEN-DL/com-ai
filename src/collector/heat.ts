/**
 * 热度加权计算（spec 决策 5「热度」+ spec「纯函数单元测试」之一）。
 *
 * 这是纯函数：不碰数据库、不看时间、不读环境变量。
 *
 * 热度由三个信号加权合成（各信号量级差几个数量级，所以先取对数再加权）：
 *   - **累计安装量**（skills.sh 的 installs）—— 主力信号，权重 0.7；
 *   - **仓库 star 数**（GitHub）—— 辅助信号，权重 0.3；
 *   - **近期趋势**（skills.sh 给的 8 周安装量）—— 乘性修正，范围 ±30%。
 *
 * 为什么用对数：安装量从 100 到 4,000,000 跨了 4 个数量级，
 * 线性加权会让安装量完全盖过 star 数，热度榜就退化成纯安装量榜。
 */
export type HeatInput = {
  /// 累计安装量。
  installs: number;
  /// 仓库 star 数。
  stars: number;
  /// 近 8 周的周安装量（从旧到新）。
  weeklyInstalls?: number[];
};

/// 安装量的权重。
const INSTALL_WEIGHT = 0.7;
/// star 数的权重。
const STAR_WEIGHT = 0.3;
/// 趋势修正的最大幅度（±30%）。
const TREND_FACTOR = 0.3;

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * 趋势：最近一半的周安装量 vs 更早一半的周安装量。
 *
 * 返回值夹在 [-1, 1]：1 = 翻倍增长，-1 = 腰斩。样本不足 4 周时返回 0（没有趋势可言）。
 */
export function weeklyTrend(weeklyInstalls: number[] | undefined): number {
  if (!Array.isArray(weeklyInstalls) || weeklyInstalls.length < 4) {
    return 0;
  }
  const values = weeklyInstalls.map(nonNegative);
  const half = Math.floor(values.length / 2);
  const older = values.slice(0, half).reduce((sum, value) => sum + value, 0);
  const recent = values.slice(values.length - half).reduce((sum, value) => sum + value, 0);

  if (older <= 0) {
    // 没有历史基数：有量就是增长，没量就没有趋势。
    return recent > 0 ? 1 : 0;
  }
  const ratio = (recent - older) / older;
  return Math.max(-1, Math.min(1, ratio));
}

/** 热度分（0 ~ 10 量级）。 */
export function computeHeatScore(input: HeatInput): number {
  const installs = nonNegative(input.installs);
  const stars = nonNegative(input.stars);

  const base =
    INSTALL_WEIGHT * Math.log10(1 + installs) + STAR_WEIGHT * Math.log10(1 + stars);
  const trend = weeklyTrend(input.weeklyInstalls);
  const score = base * (1 + TREND_FACTOR * trend);

  return Math.round(score * 10_000) / 10_000;
}
