/**
 * 命令行公共参数解析（纯函数，无副作用）。
 *
 * ## 为什么要单独一个模块
 *
 * 1. **可测**：`scenario-cli.ts` / `summary-cli.ts` 这类入口文件在模块顶层就
 *    调 `main()`，直接 import 它们会**真的去连库跑一遍**。
 *    把解析逻辑抽到这里，测试就能直接 import 纯函数。
 * 2. **不重复**：两个 CLI 的参数表本来是两份几乎一样的代码。
 * 3. **下标别写错**：这里踩过一次真实的坑 ——
 *    解析器收的是 `process.argv.slice(2)`（去掉了 node 与脚本路径），
 *    取值却写成了 `process.argv[i + 1]`，
 *    于是 `--limit 100` 读回脚本路径（`Number("/…/x.mjs")` = NaN，上限静默失效），
 *    `--slug foo` 把脚本路径当成 slug（扫 0 条且不报错）。
 *
 * ⚠️ **取值只能是 `argv[i + 1]`**，不能是 `process.argv[i + 1]`。
 *    `argv` 已经是切过的，下标差一位。
 *
 * 参数不认识就**忽略**（不报错）—— 命令行入口要能接受未来新增的开关。
 * 取值不合法（非正数 / 空串）同样**忽略**，让调用方走默认值。
 */

/** 解析出来的公共参数。 */
export type CliArgs = {
  /// `--limit N`：最多处理多少个。
  limit?: number;
  /// `--slug X`：只处理这些 slug（可重复）。
  slugs: string[];
  /// `--version X`：摘要生成器版本号。
  version?: string;
  /// `--force`：忽略缓存强制重算。
  force: boolean;
  /// `--dry-run`：只统计，不写库。
  dryRun: boolean;
  /// `--prune`：顺便清理孤儿数据。
  prune: boolean;
};

/**
 * 解析命令行参数。
 *
 * @param argv 已经切掉 `node` 与脚本路径的参数数组（`process.argv.slice(2)`）。
 */
export function parseCliArgs(argv: string[]): CliArgs {
  const options: CliArgs = { slugs: [], force: false, dryRun: false, prune: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--limit") {
      const value = Number(argv[i + 1]);
      i += 1;
      if (Number.isFinite(value) && value > 0) {
        options.limit = Math.floor(value);
      }
      continue;
    }
    if (arg === "--version") {
      const value = argv[i + 1];
      i += 1;
      if (typeof value === "string" && value.trim().length > 0) {
        options.version = value.trim();
      }
      continue;
    }
    if (arg === "--slug") {
      const value = argv[i + 1];
      i += 1;
      if (typeof value === "string" && value.trim().length > 0) {
        options.slugs.push(value.trim());
      }
      continue;
    }
    if (arg === "--force") {
      options.force = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--prune") {
      options.prune = true;
      continue;
    }
  }

  return options;
}
