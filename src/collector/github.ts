/**
 * GitHub 回源适配器：从一个 GitHub 仓库定位并取回原始 `SKILL.md` 与 frontmatter。
 *
 * 端点事实（实测，见 .com-ai-context/verified-endpoints.md 第 1.1–1.3 节）：
 *   - 列表：`GET https://api.github.com/repos/{owner}/{repo}/git/trees/{branch}?recursive=1`
 *     —— **一次拿全树再本地筛**，绝不逐文件请求（未认证只有 60 次/小时）。
 *   - 正文：`GET https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}`
 *     —— token **不要**发给 raw 域。
 *   - 路径布局实测有三套（`skills/<name>/`、`skills/<category>/<name>/`、
 *     `.automations` 开头的 CI 目录下的 `skills/<name>/`），**不能拼路径猜**，
 *     只信 trees API 返回的 path。
 *   - `SKILL.md` 必须严格比较**最后一段**：`path.split("/").pop() === "SKILL.md"`。
 *     `endsWith("SKILL.md")` 会误命中 `.changeset/software-factory-skill.md`。
 *   - `truncated: true` 表示结果被截断，必须用返回的子 tree url 继续递归。
 *
 * 合规：只访问 GitHub 的公开 API 与 raw 域，不碰任何被 robots.txt 禁止的 `/api/` 路径。
 */
import { SourceConfigError, SourceStructureError } from "@/collector/errors";
import { frontmatterString, parseFrontmatter } from "@/collector/frontmatter";
import { createHttpClient, fetchJson, fetchText, type HttpClient } from "@/collector/http";
import type {
  ExtraFile,
  FetchResult,
  GitHubRepoSourceConfig,
  RawItem,
  SourceAdapter,
  SourceType,
} from "@/collector/types";

const GITHUB_API = "https://api.github.com";
const GITHUB_RAW = "https://raw.githubusercontent.com";

type GitHubTreeEntry = {
  path: string;
  /// `tree` | `blob` | `commit`；实测总是有，但按可选读。
  type?: string;
  /// 仅 blob 有。
  size?: number;
  /// 子 tree 的 API 地址（truncated 时用来递归）。
  url?: string;
};

/** 仓库元数据里我们认识的字段。 */
type GitHubRepoResponse = {
  full_name: string;
  default_branch: string;
  stargazers_count?: number;
  license?: { spdx_id?: string | null } | null;
};

export type GitHubRepoAdapterOptions = {
  /// 注入 HTTP 客户端（测试用 fixture 驱动；生产用默认的带容错实现）。
  http?: HttpClient;
  /// GitHub token。不给则从环境变量读；都没有 = 未认证（60 次/小时）。
  token?: string | null;
  apiBase?: string;
  rawBase?: string;
};

/** 从环境变量读 GitHub token。绝不在代码里硬编码。 */
export function readGitHubToken(): string | null {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
  const trimmed = token.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 仓库元数据是否是我们认识的形状。 */
function isRepoResponse(value: unknown): value is GitHubRepoResponse {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.full_name !== "string" || typeof value.default_branch !== "string") {
    return false;
  }
  if (
    value.stargazers_count !== undefined &&
    typeof value.stargazers_count !== "number"
  ) {
    return false;
  }
  if (
    value.license !== undefined &&
    value.license !== null &&
    !isRecord(value.license)
  ) {
    return false;
  }
  return true;
}

/** SKILL.md 的 slug：owner + repo + skill 名，全小写，非字母数字折成连字符。 */
export function buildSlug(owner: string, repo: string, skillName: string): string {
  const raw = `${owner}-${repo}-${skillName}`;
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** 仓库内相对路径 → URL 路径段（逐段编码，保留 `/`）。 */
function encodeRepoPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export class GitHubRepoAdapter implements SourceAdapter<GitHubRepoSourceConfig> {
  private readonly http: HttpClient;
  private readonly token: string | null;
  private readonly apiBase: string;
  private readonly rawBase: string;

  constructor(options: GitHubRepoAdapterOptions = {}) {
    this.http = options.http ?? createHttpClient();
    this.token = options.token === undefined ? readGitHubToken() : options.token;
    this.apiBase = options.apiBase ?? GITHUB_API;
    this.rawBase = options.rawBase ?? GITHUB_RAW;
  }

  getName(): SourceType {
    return "github-repo";
  }

  validateConfig(config: GitHubRepoSourceConfig): boolean {
    return Boolean(
      config &&
        config.type === "github-repo" &&
        typeof config.owner === "string" &&
        config.owner.trim().length > 0 &&
        typeof config.repo === "string" &&
        config.repo.trim().length > 0,
    );
  }

  async fetch(config: GitHubRepoSourceConfig): Promise<FetchResult> {
    if (!this.validateConfig(config)) {
      throw new SourceConfigError(this.getName(), `owner / repo 不能为空：${JSON.stringify(config)}`);
    }

    const owner = config.owner.trim();
    const repo = config.repo.trim();
    const repoApiUrl = `${this.apiBase}/repos/${owner}/${repo}`;

    // ① 仓库元数据：许可证、默认分支、star 数。
    const repoPayload = await fetchJson<unknown>(this.http, repoApiUrl, {
      headers: this.apiHeaders(),
    });
    if (!isRepoResponse(repoPayload)) {
      throw new SourceStructureError(
        this.getName(),
        `仓库元数据缺少 full_name / default_branch 字段：${repoApiUrl}`,
      );
    }

    const branch = config.branch?.trim() || repoPayload.default_branch;
    const stars = typeof repoPayload.stargazers_count === "number" ? repoPayload.stargazers_count : 0;
    const license = this.readRepoLicense(repoPayload);

    // ② 一次拿全树，再本地筛 SKILL.md。
    const treeUrl = `${repoApiUrl}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
    const treePayload = await fetchJson<unknown>(this.http, treeUrl, {
      headers: this.apiHeaders(),
    });
    const entries = await this.collectTreeEntries(treePayload, treeUrl);

    const skillPaths = entries
      .filter((entry) => this.isSkillFile(entry))
      .map((entry) => entry.path)
      .filter((path) => (config.skillPath ? path === config.skillPath : true));

    // ③ 逐个取原文、解析 frontmatter。
    const issues: string[] = [];
    const candidates: { item: RawItem; depth: number }[] = [];

    for (const path of skillPaths) {
      const rawUrl = `${this.rawBase}/${owner}/${repo}/${encodeURIComponent(branch)}/${encodeRepoPath(path)}`;
      let raw: string;
      try {
        raw = await fetchText(this.http, rawUrl);
      } catch (error) {
        issues.push(`${path} 取回失败：${error instanceof Error ? error.message : String(error)}`);
        continue;
      }

      let frontmatter: Record<string, unknown>;
      try {
        frontmatter = parseFrontmatter(raw).data;
      } catch (error) {
        issues.push(`${path} frontmatter 解析失败：${error instanceof Error ? error.message : String(error)}`);
        continue;
      }

      const directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      const directoryName = directory.includes("/")
        ? directory.slice(directory.lastIndexOf("/") + 1)
        : directory;
      const skillName = frontmatterString(frontmatter, "name") ?? directoryName;
      if (!skillName) {
        issues.push(`${path} 既没有 frontmatter.name 也无法从路径推断名称，已跳过`);
        continue;
      }

      candidates.push({
        depth: path.split("/").length,
        item: {
          slug: buildSlug(owner, repo, skillName),
          title: skillName,
          url: rawUrl,
          content: raw,
          publishedAt: null,
          metadata: {
            kind: "SKILL",
            sourceId: this.getName(),
            description: frontmatterString(frontmatter, "description"),
            frontmatter,
            license,
            repoOwner: owner,
            repoName: repo,
            repoUrl: `https://github.com/${owner}/${repo}`,
            upstreamUrl: rawUrl,
            skillPath: path,
            extraFiles: this.collectExtraFiles(entries, path),
            stars,
            installs: 0,
            heatScore: 0,
            isOfficial: false,
          },
        },
      });
    }

    // ④ 同名去重：同一个 frontmatter name 可能出现在多个路径（如 CI 复制品），
    //    保留路径最短的那一个。
    const bySlug = new Map<string, { item: RawItem; depth: number }>();
    for (const candidate of candidates) {
      const existing = bySlug.get(candidate.item.slug);
      if (!existing || candidate.depth < existing.depth) {
        if (existing) {
          issues.push(
            `${candidate.item.metadata.skillPath} 与 ${existing.item.metadata.skillPath} 同名（${candidate.item.slug}），已保留路径较短的一个`,
          );
        }
        bySlug.set(candidate.item.slug, candidate);
      } else {
        issues.push(
          `${candidate.item.metadata.skillPath} 与 ${existing.item.metadata.skillPath} 同名（${candidate.item.slug}），已跳过`,
        );
      }
    }

    const items = [...bySlug.values()].map((candidate) => candidate.item);

    return {
      source: `${owner}/${repo}`,
      sourceType: this.getName(),
      items,
      error: issues.length > 0 ? issues.join("；") : undefined,
    };
  }

  /** 是否是一个 SKILL.md 文件。 */
  private isSkillFile(entry: GitHubTreeEntry): boolean {
    if (entry.type === "tree" || entry.type === "commit") {
      return false;
    }
    // 严格比较最后一段：`.changeset/software-factory-skill.md` 不是 SKILL.md。
    const segments = entry.path.split("/");
    return segments[segments.length - 1] === "SKILL.md";
  }

  /** 与 SKILL.md 同目录的附属文件（只存元数据）。 */
  private collectExtraFiles(entries: GitHubTreeEntry[], skillPath: string): ExtraFile[] {
    const directory = skillPath.includes("/")
      ? skillPath.slice(0, skillPath.lastIndexOf("/"))
      : "";
    if (!directory) {
      return [];
    }
    const prefix = `${directory}/`;

    return entries
      .filter((entry) => entry.path.startsWith(prefix))
      .filter((entry) => entry.path !== skillPath)
      .filter((entry) => entry.type !== "tree")
      .map((entry) => ({
        path: entry.path,
        size: typeof entry.size === "number" ? entry.size : null,
      }));
  }

  /** 仓库声明的 SPDX 许可证 id；没有就是 null（下游按最严格档处理）。 */
  private readRepoLicense(repoPayload: GitHubRepoResponse): string | null {
    const spdxId = repoPayload.license?.spdx_id;
    if (typeof spdxId !== "string" || spdxId.trim().length === 0) {
      return null;
    }
    return spdxId.trim().toLowerCase();
  }

  /**
   * 展开 trees 响应。`truncated: true` 时用返回的子 tree url 继续递归，
   * 否则大仓库会静默漏掉一部分 SKILL.md。
   */
  private async collectTreeEntries(
    payload: unknown,
    url: string,
    prefix = "",
    visited: Set<string> = new Set(),
  ): Promise<GitHubTreeEntry[]> {
    if (!isRecord(payload)) {
      throw new SourceStructureError(this.getName(), `trees 接口返回的不是对象：${url}`);
    }
    const tree = payload.tree;
    if (!Array.isArray(tree)) {
      throw new SourceStructureError(this.getName(), `trees 接口的 tree 字段不是数组：${url}`);
    }

    const entries = tree
      .filter((entry): entry is GitHubTreeEntry => isRecord(entry) && typeof entry.path === "string")
      .map((entry) => ({ ...entry, path: `${prefix}${entry.path}` }));

    if (payload.truncated !== true) {
      return entries;
    }

    const subTrees = entries.filter(
      (entry) => entry.type === "tree" && typeof entry.url === "string",
    );

    const collected: GitHubTreeEntry[] = [];
    for (const subTree of subTrees) {
      const subUrl = subTree.url as string;
      if (visited.has(subUrl)) {
        continue;
      }
      visited.add(subUrl);

      const childPayload = await fetchJson<unknown>(this.http, `${subUrl}?recursive=1`, {
        headers: this.apiHeaders(),
      });
      collected.push(
        ...(await this.collectTreeEntries(
          childPayload,
          subUrl,
          `${subTree.path}/`,
          visited,
        )),
      );
    }

    return [...entries, ...collected];
  }

  /** GitHub API 请求头。token 只发给 api.github.com。 */
  private apiHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    return headers;
  }
}
