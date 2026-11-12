/**
 * 每个测试文件加载一次：准备清库工具，并保证每个测试开始前表是干净的。
 *
 * 隔离策略：harness 每次运行建独立数据库（worktree 之间不干扰），
 * 文件之间串行执行 + 每个测试前清库（测试之间不干扰）。
 */
import { beforeEach } from "vitest";

import { resetDatabase } from "./helpers/db";

beforeEach(async () => {
  await resetDatabase();
});
