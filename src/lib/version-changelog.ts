/**
 * 变更摘要的生成（票 #16「版本管理与一键更新」）。
 *
 * 上游差异来自 GitHub 的 Compare API（`GET /repos/{owner}/{repo}/compare/{base}...{head}`）。
 * 它的响应有三种形态，都得处理：
 *
 *   1. **正常**：带 `commits` 与 `files`（文件级差异，可能因仓库太大而缺失）；
 *   2. **`too_large`**：差异太大，GitHub 只给一个计数，不给文件明细；
 *   3. **取不到**（404 / 限流 / 网络抖动）：连差异都没有。
 *
 * 后两种必须**降级**，不能整轮同步失败 —— 降级后的摘要仍然要说清「变了什么」，
 * 只是精度下降（"N 个提交"而不是文件级明细）。
 *
 * 这里全是纯函数：输入是已解析好的响应片段，输出是人类可读的中文摘要。
 */
/** 文件级差异里的一条。 */
export type CompareFile = {
  /// 文件路径（仓库内相对路径）。
  filename: string;
  /// 变更类型：`added` / `removed` / `modified` / `renamed`。
  status: string;
  /// 新增行数。
  additions: number;
  /// 删除行数。
  deletions: number;
  /// 变更总行数。
  changes: number;
};

/** 对比范围内的一个提交。 */
export type CompareCommit = {
  /// commit sha。
  sha: string;
  /// 提交信息（完整，含正文）。
  message: string;
};

/** 一次对比的结果。 */
export type CompareOutcome =
  /// 拿到了文件级差异。
  | {
      kind: "diff";
      /// 上游领先的提交数（GitHub 的 `ahead_by`）。
      aheadBy: number | null;
      /// 本次对比涉及的提交总数。
      totalCommits: number | null;
      files: CompareFile[];
      commits: CompareCommit[];
    }
  /// 差异太大（GitHub 返回 `status: "too_large"`）：只有计数，没有文件明细。
  | { kind: "too_large"; aheadBy: number | null; commits: CompareCommit[] }
  /// 差异完全取不到（404 / 限流 / 网络错误）。
  | { kind: "unavailable"; reason: string; commits: CompareCommit[] };

/** 变更摘要。 */
export type ChangelogSummary = {
  /// 人类可读的变更摘要（落进 `AssetVersion.changelog`）。
  text: string;
  /// 变更的文件数（拿不到文件明细时为 0）。
  filesChanged: number;
  /// 新增行数。
  additions: number;
  /// 删除行数。
  deletions: number;
  /// 是否走了降级路径（拿不到文件级明细）。
  degraded: boolean;
};

/** 摘要里最多列出的文件名个数（再多就没人看了）。 */
const MAX_LISTED_FILES = 5;
/** 摘要里最多列出的提交条数。 */
const MAX_LISTED_COMMITS = 3;
/**
 * GitHub Compare API 的硬上限（实测，见 .com-ai-context/verified-endpoints.md）：
 * 一次对比最多返回 **250 条提交**与 **300 个文件**，超出的部分静默截断。
 */
const GITHUB_MAX_COMMITS = 250;
const GITHUB_MAX_FILES = 300;

/**
 * 把一次对比结果汇总成变更摘要。
 *
 * 三种结果各有各的措辞，**不共用一句话**：
 *   - 有文件明细 → 说清「几个文件、增删多少行、哪些文件」；
 *   - 差异太大 → 说清「领先几个提交」，并列出最近的提交标题；
 *   - 取不到差异 → 明说「差异详情暂不可用」，但仍列出提交标题（如果拿到了）。
 */
export function summarizeCompare(outcome: CompareOutcome): ChangelogSummary {
  if (outcome.kind === "diff") {
    return summarizeDiff(outcome);
  }
  if (outcome.kind === "too_large") {
    return summarizeTooLarge(outcome);
  }
  return summarizeUnavailable(outcome);
}

/** 有文件级明细时的摘要。 */
function summarizeDiff(outcome: Extract<CompareOutcome, { kind: "diff" }>): ChangelogSummary {
  const files = outcome.files;
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);

  const lines: string[] = [];
  const head = `${files.length} 个文件变更（+${additions} / -${deletions} 行）`;
  const listedFiles = files.slice(0, MAX_LISTED_FILES).map((file) => file.filename);
  lines.push(listedFiles.length > 0 ? `${head}：${listedFiles.join("、")}` : head);

  if (files.length > listedFiles.length) {
    lines.push(`另有 ${files.length - listedFiles.length} 个文件变更。`);
  }

  // GitHub 会静默截断提交（250 条）与文件（300 个）。摘要里说清楚，
  // 别让人以为「就改了这么多」。
  if (outcome.files.length >= GITHUB_MAX_FILES) {
    lines.push(`（GitHub 最多返回 ${GITHUB_MAX_FILES} 个文件，更早的文件没列出来。）`);
  }
  if (outcome.aheadBy !== null && outcome.commits.length < outcome.aheadBy) {
    lines.push(`（提交共 ${outcome.aheadBy} 条，GitHub 最多返回 ${GITHUB_MAX_COMMITS} 条。）`);
  }

  const commits = describeCommits(outcome.commits);
  if (commits) {
    lines.push(commits);
  }

  return {
    text: lines.join("\n"),
    filesChanged: files.length,
    additions,
    deletions,
    degraded: false,
  };
}

/** 差异太大时的摘要（拿不到文件明细）。 */
function summarizeTooLarge(outcome: Extract<CompareOutcome, { kind: "too_large" }>): ChangelogSummary {
  const ahead = outcome.aheadBy ?? outcome.commits.length;
  const lines: string[] = [`上游领先 ${ahead} 个提交（差异过大，未取到文件级明细）。`];

  const commits = describeCommits(outcome.commits);
  if (commits) {
    lines.push(commits);
  }

  return { text: lines.join("\n"), filesChanged: 0, additions: 0, deletions: 0, degraded: true };
}

/** 差异完全取不到时的摘要。 */
function summarizeUnavailable(
  outcome: Extract<CompareOutcome, { kind: "unavailable" }>,
): ChangelogSummary {
  const lines: string[] = ["上游有新提交，但差异详情暂不可用。"];
  if (outcome.reason) {
    lines.push(`原因：${outcome.reason}`);
  }

  const commits = describeCommits(outcome.commits);
  if (commits) {
    lines.push(commits);
  }

  return { text: lines.join("\n"), filesChanged: 0, additions: 0, deletions: 0, degraded: true };
}

/**
 * 降级摘要：只有提交列表时的措辞。
 *
 * Compare API 拿不到差异时，退回到「最近几个提交」—— 至少让用户知道
 * 上游动了什么，而不是只看到一个「已更新」。
 */
export function summarizeCommits(
  commits: CompareCommit[],
  options: { aheadBy?: number | null; prefix?: string } = {},
): ChangelogSummary {
  const ahead = options.aheadBy ?? commits.length;
  const prefix = options.prefix ?? `上游有 ${ahead} 个新提交。`;
  const lines: string[] = [prefix];

  const described = describeCommits(commits);
  if (described) {
    lines.push(described);
  }

  return { text: lines.join("\n"), filesChanged: 0, additions: 0, deletions: 0, degraded: true };
}

/**
 * 首次记录版本时的摘要（还没有「上一版」可比）。
 *
 * ⚠️ 站内此前的正文是采集器按**分支**取的，没有记录它对应哪个 commit，
 *    所以第一次同步**没法**跟它做文件级比对 —— 这里说清楚，别让人误以为
 *    「这一版跟之前一模一样」。
 */
export function summarizeInitialVersion(version: string): ChangelogSummary {
  return {
    text: `首次记录版本 ${version}。此前站内正文没有对应的 commit 记录，差异无法比对。`,
    filesChanged: 0,
    additions: 0,
    deletions: 0,
    degraded: false,
  };
}

/**
 * 把提交列表拼成一行摘要：只取每个提交标题的第一行。
 *
 * 提交正文（body）不进摘要 —— 摘要要短，且提交正文经常是模板化的长文。
 */
function describeCommits(commits: CompareCommit[]): string | null {
  const titles = commits
    .map((commit) => commit.message.split("\n")[0]?.trim() ?? "")
    .filter((title) => title.length > 0)
    .slice(0, MAX_LISTED_COMMITS);

  if (titles.length === 0) {
    return null;
  }

  return `提交：${titles.join("；")}`;
}
