/**
 * GitHub 的版本取数（票 #16「版本管理与一键更新」）。
 *
 * ## 为什么单独一个模块
 *
 * 采集器（`github.ts`）已经会取仓库元数据、文件树与文件正文，但**版本管理要的东西不一样**：
 *   - commit 列表（`GET /repos/{owner}/{repo}/commits?per_page=N`）—— 用来发现新版本；
 *   - 两个 commit 之间的差异（`GET /repos/{owner}/{repo}/compare/{base}...{head}`）—— 用来生成变更日志；
 *   - 某个 ref 下的文件正文（raw 域）—— 用来把新版本的内容回写。
 *
 * 取数的**基础设施是共用的**：HTTP 客户端（超时 / 重试 / 限流退避 / UA 轮换）
 * 与 GitHub 请求头都复用 `@/collector/http` 与 `@/collector/github`，
 * 这里**不另写一套 HTTP 客户端**。
 *
 * ## 配额
 *
 * 未认证 60 次/小时，认证 5000 次/小时（实测见 .com-ai-context/verified-endpoints.md）。
 * 版本同步比采集轻：查一次 commit 列表就够判定「有没有新版本」，
 * 只有真的有新版本时才多花一次 compare。
 *
 * ## 合规
 *
 * 只访问 GitHub 的公开 API 与 raw 域，不碰任何被 robots.txt 禁止的 `/api/` 路径。
 */
import { SourceStructureError } from "@/collector/errors";
import { createHttpClient, fetchJson, fetchText, type HttpClient } from "@/collector/http";
import { githubApiHeaders, readGitHubToken } from "@/collector/github";
import type { CompareCommit, CompareFile, CompareOutcome } from "@/lib/version-changelog";

const GITHUB_API = "https://api.github.com";
const GITHUB_RAW = "https://raw.githubusercontent.com";

/** 上游的一个 commit。 */
export type HeadCommit = {
  /// commit sha（完整 40 位）。
  sha: string;
  /// 提交标题（第一行）。
  message: string;
  /// 提交时间；上游没给就是 null。
  authoredAt: Date | null;
  /// 上游页面地址；上游没给就是 null。
  url: string | null;
};

export type GitHubVersionSourceOptions = {
  /// 注入 HTTP 客户端（测试用 fixture 驱动；生产用默认的带容错实现）。
  http?: HttpClient;
  /// GitHub token。不给则从环境变量读；都没有 = 未认证（60 次/小时）。
  token?: string | null;
  apiBase?: string;
  rawBase?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 读一个字符串字段；不是字符串（或空串）返回 null。 */
function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** 读一个数字字段；不是数字返回 null。 */
function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * GitHub 上的版本取数。
 *
 * 只做「取回来 + 校验形状」，不做业务判断（比不比、要不要更新是同步服务的事）。
 */
export class GitHubVersionSource {
  private readonly http: HttpClient;
  private readonly token: string | null;
  private readonly apiBase: string;
  private readonly rawBase: string;

  constructor(options: GitHubVersionSourceOptions = {}) {
    this.http = options.http ?? createHttpClient();
    this.token = options.token === undefined ? readGitHubToken() : options.token;
    this.apiBase = options.apiBase ?? GITHUB_API;
    this.rawBase = options.rawBase ?? GITHUB_RAW;
  }

  /**
   * 取仓库默认分支的最新 commit。
   *
   * 用 `GET /repos/{owner}/{repo}/commits?per_page=1` 而不是
   * `GET /repos/{owner}/{repo}/commits/{branch}`：前者不需要先知道分支名
   * （分支名要额外一次仓库元数据请求，占配额）。
   *
   * 仓库一个 commit 都没有时返回 null（不是错误）。
   */
  async fetchHeadCommit(input: { owner: string; repo: string }): Promise<HeadCommit | null> {
    const commits = await this.fetchCommits({ ...input, perPage: 1 });
    return commits[0] ?? null;
  }

  /**
   * 取 commit 列表（新提交在前）。
   *
   * ⚠️ **结构变更必须显式失败**：响应不是数组、或某条记录缺 `sha` / 提交信息，
   *    一律抛 {@link SourceStructureError}，不能返回空数组 ——
   *    「采到 0 个 commit」和「上游结构变了」是两回事，混起来运维会误判。
   */
  async fetchCommits(input: {
    owner: string;
    repo: string;
    perPage?: number;
  }): Promise<HeadCommit[]> {
    const perPage = input.perPage ?? 5;
    const url = `${this.apiBase}/repos/${encodeRepoSegment(input.owner)}/${encodeRepoSegment(
      input.repo,
    )}/commits?per_page=${perPage}`;

    const payload = await fetchJson<unknown>(this.http, url, { headers: this.headers() });

    if (!Array.isArray(payload)) {
      throw new SourceStructureError(
        "github-versions",
        `commits 接口返回的不是数组：${url}`,
      );
    }

    return payload.map((entry, index) => this.parseCommit(entry, index, url));
  }

  /**
   * 取两个 commit 之间的差异。
   *
   * 三种结果：
   *   - `diff` —— 拿到了文件级明细；
   *   - `too_large` —— 差异太大，GitHub 只给计数（**降级**）；
   *   - `unavailable` —— compare 接口取不到（404 / 限流 / 网络抖动，**降级**）。
   *
   * 降级不是错误：版本同步不能因为拿不到差异就整轮失败。
   * 但**结构变更仍然显式失败**（抛 {@link SourceStructureError}）。
   */
  async compare(input: {
    owner: string;
    repo: string;
    base: string;
    head: string;
  }): Promise<CompareOutcome> {
    const url = `${this.apiBase}/repos/${encodeRepoSegment(input.owner)}/${encodeRepoSegment(
      input.repo,
    )}/compare/${encodeRepoSegment(input.base)}...${encodeRepoSegment(input.head)}`;

    let payload: unknown;
    try {
      payload = await fetchJson<unknown>(this.http, url, { headers: this.headers() });
    } catch (error) {
      // 404 = 这个 base commit 比不出来（force push / base 不在这个仓库里）；
      // 403/429 = 限流；网络抖动 = 临时故障。都是「拿不到差异」，不是「上游变了」。
      return {
        kind: "unavailable",
        reason: error instanceof Error ? error.message : String(error),
        commits: [],
      };
    }

    return this.parseCompare(payload, url);
  }

  /**
   * 取某个 ref（分支名或 commit sha）下的文件正文。
   *
   * raw 域**不发 token**（token 只发给 api.github.com）。
   * 取不到返回 null（文件可能在这一版里被删了）。
   */
  async fetchFileAt(input: {
    owner: string;
    repo: string;
    ref: string;
    path: string;
  }): Promise<string | null> {
    const url = `${this.rawBase}/${encodeRepoSegment(input.owner)}/${encodeRepoSegment(
      input.repo,
    )}/${encodeRepoSegment(input.ref)}/${input.path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;

    try {
      return await fetchText(this.http, url);
    } catch {
      // 文件在这一版里不存在 / 网络抖动：当作「这次没有正文」，
      // 由调用方决定要不要保留旧正文。
      return null;
    }
  }

  /** 解析一条 commit 记录。 */
  private parseCommit(entry: unknown, index: number, url: string): HeadCommit {
    if (!isRecord(entry)) {
      throw new SourceStructureError(
        "github-versions",
        `commits 接口的第 ${index + 1} 条不是对象：${url}`,
      );
    }

    const sha = readString(entry, "sha");
    if (!sha) {
      throw new SourceStructureError(
        "github-versions",
        `commits 接口的第 ${index + 1} 条缺 sha 字段：${url}`,
      );
    }

    const commit = entry.commit;
    if (!isRecord(commit)) {
      throw new SourceStructureError(
        "github-versions",
        `commits 接口的第 ${index + 1} 条缺 commit 字段：${url}`,
      );
    }

    const message = readString(commit, "message");
    if (!message) {
      throw new SourceStructureError(
        "github-versions",
        `commits 接口的第 ${index + 1} 条缺 commit.message：${url}`,
      );
    }

    const author = isRecord(commit.author) ? commit.author : null;
    const dateText = author ? readString(author, "date") : null;
    const authoredAt = dateText ? new Date(dateText) : null;

    return {
      sha,
      message,
      authoredAt: authoredAt && !Number.isNaN(authoredAt.getTime()) ? authoredAt : null,
      url: readString(entry, "html_url"),
    };
  }

  /** 解析 compare 响应。 */
  private parseCompare(payload: unknown, url: string): CompareOutcome {
    if (!isRecord(payload)) {
      throw new SourceStructureError("github-versions", `compare 接口返回的不是对象：${url}`);
    }

    const status = readString(payload, "status");
    const aheadBy = readNumber(payload, "ahead_by");
    const totalCommits = readNumber(payload, "total_commits");

    const rawCommits = payload.commits;
    if (rawCommits !== undefined && !Array.isArray(rawCommits)) {
      throw new SourceStructureError(
        "github-versions",
        `compare 接口的 commits 字段不是数组：${url}`,
      );
    }

    const rawFiles = payload.files;
    if (rawFiles !== undefined && !Array.isArray(rawFiles)) {
      throw new SourceStructureError(
        "github-versions",
        `compare 接口的 files 字段不是数组：${url}`,
      );
    }

    // 三个关键字段一个都没有 = 上游改了响应结构，必须显式失败。
    if (status === null && rawCommits === undefined && aheadBy === null) {
      throw new SourceStructureError(
        "github-versions",
        `compare 接口既没有 status / commits / ahead_by 字段：${url}`,
      );
    }

    const commits: CompareCommit[] = (rawCommits ?? []).map((entry, index) => {
      const parsed = this.parseCommit(entry, index, url);
      return { sha: parsed.sha, message: parsed.message };
    });

    if (status === "too_large") {
      return { kind: "too_large", aheadBy, commits };
    }

    const files: CompareFile[] = (rawFiles ?? []).map((entry, index) => {
      if (!isRecord(entry)) {
        throw new SourceStructureError(
          "github-versions",
          `compare 接口的第 ${index + 1} 个文件不是对象：${url}`,
        );
      }

      const filename = readString(entry, "filename");
      if (!filename) {
        throw new SourceStructureError(
          "github-versions",
          `compare 接口的第 ${index + 1} 个文件缺 filename：${url}`,
        );
      }

      return {
        filename,
        status: readString(entry, "status") ?? "modified",
        additions: readNumber(entry, "additions") ?? 0,
        deletions: readNumber(entry, "deletions") ?? 0,
        changes: readNumber(entry, "changes") ?? 0,
      };
    });

    return { kind: "diff", aheadBy, totalCommits, files, commits };
  }

  /** GitHub API 请求头（token 只发给 api.github.com）。 */
  private headers(): Record<string, string> {
    return githubApiHeaders(this.token);
  }
}

/** 仓库路径段编码（owner / repo / sha 都不该带斜杠）。 */
function encodeRepoSegment(value: string): string {
  return encodeURIComponent(value);
}
