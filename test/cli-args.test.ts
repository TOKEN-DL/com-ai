/**
 * 命令行参数解析（纯函数，不碰数据库、不打网络）。
 *
 * ## 为什么单独立一个测试文件
 *
 * 参数解析曾经在两个 CLI 里各写了一份，而且**两份都写错了下标**：
 * 解析器收的是 `process.argv.slice(2)`（去掉了 node 与脚本路径），
 * 取值却写成 `process.argv[i + 1]` —— 于是读回了脚本自己的路径：
 *
 * - `--limit 100` → `Number("/…/derive-scenarios.mjs")` = NaN → 上限**静默失效**；
 * - `--slug foo` → 把脚本路径当成 slug → 扫 0 条**且不报错**。
 *
 * 这类 bug 最容易漏：参数解析失败不抛异常，命令照样退出 0，只是没干成事。
 * 所以这里把每个开关的取值都钉死。
 */
import { describe, expect, it } from "vitest";

import { parseCliArgs } from "@/collector/cli-args";

describe("公共命令行参数解析", () => {
  it("--limit 读到的是数值，不是脚本路径", () => {
    expect(parseCliArgs(["--limit", "100"]).limit).toBe(100);
  });

  it("--slug 读到的是 slug，不是脚本路径", () => {
    expect(parseCliArgs(["--slug", "foo-bar"]).slugs).toEqual(["foo-bar"]);
  });

  it("--version 读到的是版本号", () => {
    expect(parseCliArgs(["--version", "v2"]).version).toBe("v2");
  });

  it("多个 --slug 都收进来", () => {
    expect(parseCliArgs(["--slug", "a", "--slug", "b"]).slugs).toEqual(["a", "b"]);
  });

  it("开关参数是布尔量", () => {
    const options = parseCliArgs(["--force", "--dry-run", "--prune"]);
    expect(options.force).toBe(true);
    expect(options.dryRun).toBe(true);
    expect(options.prune).toBe(true);
  });

  it("没给 --limit 时不设 limit（由调用方走默认值）", () => {
    expect(parseCliArgs([]).limit).toBeUndefined();
  });

  it("--limit 不是正整数时不采纳（不能静默变成 NaN）", () => {
    expect(parseCliArgs(["--limit", "0"]).limit).toBeUndefined();
    expect(parseCliArgs(["--limit", "-5"]).limit).toBeUndefined();
    expect(parseCliArgs(["--limit", "abc"]).limit).toBeUndefined();
  });

  it("--slug 后面没有值时不采纳（不能把 undefined 当 slug）", () => {
    expect(parseCliArgs(["--slug"]).slugs).toEqual([]);
    expect(parseCliArgs(["--slug", "   "]).slugs).toEqual([]);
  });

  it("不认识的开关被忽略（不报错），不影响其它参数", () => {
    const options = parseCliArgs(["--future-flag", "--limit", "7"]);
    expect(options.limit).toBe(7);
  });

  it("取值吃的是紧跟在开关后面的那一个参数", () => {
    // 下标错一位的典型症状：把**下一个开关**当成了值。
    const options = parseCliArgs(["--limit", "10", "--dry-run"]);
    expect(options.limit).toBe(10);
    expect(options.dryRun).toBe(true);
  });

  it("--concurrency 读到的是并发数", () => {
    expect(parseCliArgs(["--concurrency", "8"]).concurrency).toBe(8);
  });

  it("--concurrency 不是正整数时不采纳（不能静默变成 NaN）", () => {
    expect(parseCliArgs(["--concurrency", "0"]).concurrency).toBeUndefined();
    expect(parseCliArgs(["--concurrency", "-3"]).concurrency).toBeUndefined();
    expect(parseCliArgs(["--concurrency", "abc"]).concurrency).toBeUndefined();
    expect(parseCliArgs(["--concurrency"]).concurrency).toBeUndefined();
  });
});
