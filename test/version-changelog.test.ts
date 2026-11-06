/**
 * 变更摘要生成的纯函数测试（票 #16）。
 *
 * 覆盖三条路径：
 *   1. **正常**：有文件级差异 —— 摘要要说清「几个文件、增删多少行、哪些文件、哪些提交」；
 *   2. **降级**：差异太大（`too_large`）—— 只能说清「领先几个提交」；
 *   3. **降级**：差异完全取不到 —— 明说「详情不可用」，但仍列出提交标题。
 */
import { describe, expect, it } from "vitest";

import {
  summarizeCommits,
  summarizeCompare,
  summarizeInitialVersion,
  type CompareOutcome,
} from "@/lib/version-changelog";

const diffOutcome: CompareOutcome = {
  kind: "diff",
  aheadBy: 2,
  totalCommits: 2,
  files: [
    {
      filename: "skills/find-skills/SKILL.md",
      status: "modified",
      additions: 18,
      deletions: 4,
      changes: 22,
    },
    {
      filename: "skills/find-skills/README.md",
      status: "added",
      additions: 6,
      deletions: 0,
      changes: 6,
    },
  ],
  commits: [
    { sha: "aaa1111", message: "fix(find-skills): correct the install command" },
    { sha: "bbb2222", message: "feat: add batch mode\n\n长正文不进摘要。" },
  ],
};

describe("变更摘要 —— 有文件级差异", () => {
  it("说清文件数、增删行数与文件名单", () => {
    const summary = summarizeCompare(diffOutcome);

    expect(summary.filesChanged).toBe(2);
    expect(summary.additions).toBe(24);
    expect(summary.deletions).toBe(4);
    expect(summary.degraded).toBe(false);
    expect(summary.text).toContain("2 个文件变更");
    expect(summary.text).toContain("+24 / -4");
    expect(summary.text).toContain("skills/find-skills/SKILL.md");
    expect(summary.text).toContain("skills/find-skills/README.md");
  });

  it("GitHub 截断了提交与文件时说清楚（不假装列全了）", () => {
    // 实测：一次 compare 最多返回 250 条提交、300 个文件，超出静默截断。
    const files = Array.from({ length: 300 }, (_, index) => ({
      filename: `skills/skill-${index}/SKILL.md`,
      status: "modified",
      additions: 1,
      deletions: 0,
      changes: 1,
    }));

    const summary = summarizeCompare({
      kind: "diff",
      aheadBy: 399,
      totalCommits: 399,
      files,
      commits: [{ sha: "aaa1111", message: "chore: bump dependencies" }],
    });

    expect(summary.text).toContain("GitHub 最多返回 300 个文件");
    expect(summary.text).toContain("提交共 399 条");
  });

  it("提交只取标题（正文不进摘要）", () => {
    const summary = summarizeCompare(diffOutcome);

    expect(summary.text).toContain("fix(find-skills): correct the install command");
    expect(summary.text).toContain("feat: add batch mode");
    expect(summary.text).not.toContain("长正文不进摘要。");
  });

  it("文件太多时只列前几个，并说明还有多少", () => {
    const manyFiles = Array.from({ length: 9 }, (_, index) => ({
      filename: `skills/skill-${index}/SKILL.md`,
      status: "modified",
      additions: 1,
      deletions: 1,
      changes: 2,
    }));

    const summary = summarizeCompare({
      kind: "diff",
      aheadBy: 9,
      totalCommits: 9,
      files: manyFiles,
      commits: [],
    });

    expect(summary.filesChanged).toBe(9);
    expect(summary.text).toContain("9 个文件变更");
    expect(summary.text).toContain("skills/skill-4/SKILL.md");
    expect(summary.text).not.toContain("skills/skill-5/SKILL.md");
    expect(summary.text).toContain("另有 4 个文件变更");
  });
});

describe("变更摘要 —— 降级路径", () => {
  it("差异太大：说清领先几个提交，明说没有文件明细", () => {
    const summary = summarizeCompare({
      kind: "too_large",
      aheadBy: 428,
      commits: [{ sha: "ccc3333", message: "chore: bump dependencies" }],
    });

    expect(summary.degraded).toBe(true);
    expect(summary.filesChanged).toBe(0);
    expect(summary.text).toContain("上游领先 428 个提交");
    expect(summary.text).toContain("差异过大");
    expect(summary.text).toContain("chore: bump dependencies");
  });

  it("差异取不到：明说详情不可用，并保留原因", () => {
    const summary = summarizeCompare({
      kind: "unavailable",
      reason: "HTTP 404 Not Found",
      commits: [],
    });

    expect(summary.degraded).toBe(true);
    expect(summary.text).toContain("差异详情暂不可用");
    expect(summary.text).toContain("HTTP 404 Not Found");
  });

  it("只有提交列表时的兜底摘要", () => {
    const summary = summarizeCommits(
      [{ sha: "ddd4444", message: "fix: typo" }],
      { aheadBy: 1 },
    );

    expect(summary.degraded).toBe(true);
    expect(summary.text).toContain("上游有 1 个新提交");
    expect(summary.text).toContain("fix: typo");
  });

  it("首次记录版本：没有上一版可比", () => {
    const summary = summarizeInitialVersion("9f1c2b7d4e5a6f708192a3b4c5d6e7f8091a2b3c");

    expect(summary.degraded).toBe(false);
    expect(summary.text).toContain("首次记录版本");
  });
});
