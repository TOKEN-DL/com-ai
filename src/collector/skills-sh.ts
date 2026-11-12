/**
 * skills.sh 目录来源适配器（票 #6）。
 *
 * skills.sh 提供**目录与热度**，内容仍然回源 GitHub 拿原始 `SKILL.md`。
 * 这里只负责把目录变成规范化条目（没有正文），由批量编排器再回源补齐。
 *
 * 端点事实（实测，见 .com-ai-context/verified-endpoints.md 与本页脚注）：
 *   - 首页 `https://www.skills.sh/` 的 SSR 载荷里内嵌 `initialSkills`：
 *     约 600 条，每条 `{source, skillId, name, installs, weeklyInstalls[8], isOfficial?}`。
 *     载荷是 Next.js 的 RSC flight 串，**引号被转义成 `\"`**，
 *     所以解析要走「定位键 → 括号配平取数组 → 反转义 → JSON.parse」。
 *   - 站点地图 `https://www.skills.sh/sitemap-skills-1.xml` 与 `-2.xml`：
 *     各 10,000 条 `https://www.skills.sh/{owner}/{repo}/{skillId}`，共 20,000 条。
 *   - 站点地图只给目录，**没有安装量**；榜单才有热度。
 *
 * ⚠️ 合规：只访问**公开页面路径**（首页 + sitemap）。
 *    `/api/search` 与 `/api/v1/*` 被 robots.txt 明确 `Disallow: /api/`，
 *    官方 v1 API 又需要 Vercel OIDC（无 token 一律 401）——两条路都不走。
 *    自动化护栏见 test/collector-robots-guard.test.ts。
 *
 * ⚠️ 结构变更必须显式失败：解析不到榜单载荷 / 载荷字段改名 / sitemap 形状变了，
 *    一律抛 {@link SourceStructureError}，**不返回空数组**。
 */
import { SourceConfigError, SourceStructureError } from "@/collector/errors";
import { buildSlug } from "@/collector/github";
import { createHttpClient, fetchText, type HttpClient } from "@/collector/http";
import type {
  FetchResult,
  RawItem,
  SourceAdapter,
  SourceType,
  SkillsShSourceConfig,
} from "@/collector/types";

const SKILLS_SH_BASE = "https://www.skills.sh";
const SKILLS_SH_SITEMAPS = [
  `${SKILLS_SH_BASE}/sitemap-skills-1.xml`,
  `${SKILLS_SH_BASE}/sitemap-skills-2.xml`,
];

/** GitHub 的 owner / repo 名允许的字符。 */
const GITHUB_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/** 一个 GitHub 仓库 slug：`owner/repo`。 */
const GITHUB_SLUG = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

export type SkillsShAdapterOptions = {
  /// 注入 HTTP 客户端（测试用 fixture 驱动；生产用默认的带容错实现）。
  http?: HttpClient;
  base?: string;
};

/** 榜单条目（`initialSkills` 数组里的一项）的形状。 */
type LeaderboardEntry = {
  source: string;
  skillId: string;
  name: string;
  installs: number;
  weeklyInstalls: number[];
  isOfficial: boolean;
};

/** 反转义 RSC 载荷里的转义序列（`\"` `\"` `\n` `\uXXXX` …）。 */
function unescapeRsc(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = text[i + 1];
    i += 1;
    if (next === "n") out += "\n";
    else if (next === "t") out += "\t";
    else if (next === "r") out += "\r";
    else if (next === "u") {
      out += String.fromCharCode(Number.parseInt(text.slice(i + 1, i + 5), 16));
      i += 4;
    } else {
      // `\"` → `"`，`\\` → `\`，其余原样。
      out += next ?? "";
    }
  }
  return out;
}

/**
 * 从 `start`（指向 `[`）开始按括号配平取出一个数组字面量。
 *
 * 跳过字符串字面量里的括号与转义引号 —— RSC 载荷里的描述文本经常带括号。
 */
export function extractBracketArray(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** 找出所有出现位置。 */
function findAll(text: string, needle: string): number[] {
  const positions: number[] = [];
  let index = text.indexOf(needle);
  while (index !== -1) {
    positions.push(index);
    index = text.indexOf(needle, index + needle.length);
  }
  return positions;
}

/**
 * 从 SSR 载荷里取出 `initialSkills` 数组。
 *
 * 找不到或解析不了就抛 {@link SourceStructureError} —— 上游改版必须显式失败。
 */
export function extractInitialSkills(html: string): unknown[] {
  const failures: string[] = [];

  for (const keyIndex of findAll(html, "initialSkills")) {
    const colonIndex = html.indexOf(":", keyIndex);
    if (colonIndex === -1) {
      failures.push("initialSkills 后面找不到冒号");
      continue;
    }
    const bracketIndex = html.indexOf("[", colonIndex);
    if (bracketIndex === -1) {
      failures.push("initialSkills 后面找不到数组起始符");
      continue;
    }
    const raw = extractBracketArray(html, bracketIndex);
    if (raw === null) {
      failures.push("initialSkills 的数组没有闭合");
      continue;
    }
    try {
      const parsed = JSON.parse(unescapeRsc(raw)) as unknown;
      if (Array.isArray(parsed)) {
        return parsed;
      }
      failures.push("initialSkills 解析出来不是数组");
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  throw new SourceStructureError(
    "skills-sh",
    `首页里取不到 initialSkills 榜单载荷（试了 ${failures.length} 处）：${failures.join("；") || "没找到关键字"}`,
  );
}

/** 榜单条目 → 规范化字段。返回 null 表示这条不可用。 */
function toLeaderboardEntry(value: unknown): LeaderboardEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const entry = value as Record<string, unknown>;

  const source = entry.source;
  const skillId = entry.skillId;
  const name = entry.name;
  const installs = entry.installs;
  const weekly = entry.weeklyInstalls;

  if (typeof source !== "string" || typeof skillId !== "string" || typeof name !== "string") {
    return null;
  }
  if (typeof installs !== "number" || !Number.isFinite(installs)) {
    return null;
  }
  if (!Array.isArray(weekly) || weekly.some((value) => typeof value !== "number")) {
    return null;
  }

  return {
    source,
    skillId,
    name,
    installs,
    weeklyInstalls: weekly as number[],
    isOfficial: entry.isOfficial === true,
  };
}

/** sitemap 里的 `<loc>` 文本。 */
export function parseSitemapLocs(xml: string): string[] {
  const out: string[] = [];
  const pattern = /<loc>\s*([^<]+?)\s*<\/loc>/g;
  let match = pattern.exec(xml);
  while (match !== null) {
    out.push(match[1]);
    match = pattern.exec(xml);
  }
  return out;
}

/** skill URL → owner / repo / skillId。不是 skill URL 就返回 null。 */
export function parseSkillUrl(url: string): {
  owner: string;
  repo: string;
  skillId: string;
} | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname !== "www.skills.sh" && parsed.hostname !== "skills.sh") {
    return null;
  }
  const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 3) {
    return null;
  }
  const [owner, repo, skillId] = segments;
  if (!GITHUB_SEGMENT.test(owner) || !GITHUB_SEGMENT.test(repo)) {
    return null;
  }
  if (skillId.length === 0 || /\s/.test(skillId)) {
    return null;
  }
  return { owner, repo, skillId };
}

export class SkillsShAdapter implements SourceAdapter<SkillsShSourceConfig> {
  private readonly http: HttpClient;
  private readonly base: string;

  constructor(options: SkillsShAdapterOptions = {}) {
    this.http = options.http ?? createHttpClient();
    this.base = (options.base ?? SKILLS_SH_BASE).replace(/\/+$/, "");
  }

  getName(): SourceType {
    return "skills-sh";
  }

  validateConfig(config: SkillsShSourceConfig): boolean {
    return Boolean(
      config &&
        config.type === "skills-sh" &&
        (config.catalog === "leaderboard" || config.catalog === "sitemap"),
    );
  }

  async fetch(config: SkillsShSourceConfig): Promise<FetchResult> {
    if (!this.validateConfig(config)) {
      throw new SourceConfigError(
        this.getName(),
        `catalog 必须是 leaderboard 或 sitemap：${JSON.stringify(config)}`,
      );
    }

    return config.catalog === "leaderboard"
      ? this.fetchLeaderboard()
      : this.fetchSitemap();
  }

  /** 首页榜单：带 installs 与 8 周趋势。 */
  private async fetchLeaderboard(): Promise<FetchResult> {
    const html = await fetchText(this.http, `${this.base}/`);
    const payload = extractInitialSkills(html);

    const issues: string[] = [];
    const items: RawItem[] = [];
    const seen = new Set<string>();
    const skippedSources = new Set<string>();

    for (const raw of payload) {
      const entry = toLeaderboardEntry(raw);
      if (entry === null) {
        issues.push("有条榜单记录的字段不符合预期（需要 source / skillId / name / installs / weeklyInstalls）");
        continue;
      }

      const slug = GITHUB_SLUG.exec(entry.source);
      if (slug === null) {
        // 非 GitHub 来源（如站点域名）：本站只回源 GitHub，跳过并记账。
        skippedSources.add(entry.source);
        continue;
      }

      const key = `${entry.source}#${entry.skillId}`;
      if (seen.has(key)) {
        issues.push(`榜单里有重复条目：${key}`);
        continue;
      }
      seen.add(key);

      const [owner, repo] = slug.slice(1);
      items.push({
        slug: buildSlug(owner, repo, entry.skillId),
        title: entry.name,
        url: `${this.base}/${owner}/${repo}/${entry.skillId}`,
        publishedAt: null,
        metadata: {
          kind: "SKILL",
          sourceId: "skills.sh",
          description: null,
          frontmatter: {},
          license: null,
          repoOwner: owner,
          repoName: repo,
          repoUrl: `https://github.com/${owner}/${repo}`,
          upstreamUrl: null,
          skillPath: "",
          extraFiles: [],
          stars: 0,
          installs: entry.installs,
          heatScore: 0,
          isOfficial: entry.isOfficial,
          skillId: entry.skillId,
          weeklyInstalls: entry.weeklyInstalls,
        },
      });
    }

    if (items.length === 0) {
      throw new SourceStructureError(
        this.getName(),
        `榜单载荷解析出 ${payload.length} 条，但没有一条是可用的 GitHub 目录条目`,
      );
    }

    if (skippedSources.size > 0) {
      // 非 GitHub 来源汇总成一条，别一条条刷屏。
      issues.unshift(
        `跳过 ${skippedSources.size} 种非 GitHub 来源：${[...skippedSources].join("、")}`,
      );
    }

    return {
      source: "skills.sh:leaderboard",
      sourceType: this.getName(),
      items,
      error: issues.length > 0 ? issues.join("；") : undefined,
    };
  }

  /** 站点地图：只有目录，没有热度。 */
  private async fetchSitemap(): Promise<FetchResult> {
    const issues: string[] = [];
    const items: RawItem[] = [];
    const seen = new Set<string>();
    let skipped = 0;

    for (const sitemapUrl of SKILLS_SH_SITEMAPS.map((url) => url.replace(SKILLS_SH_BASE, this.base))) {
      const xml = await fetchText(this.http, sitemapUrl);
      const locs = parseSitemapLocs(xml);
      if (locs.length === 0) {
        issues.push(`${sitemapUrl} 里没有 <loc> 条目`);
        continue;
      }

      for (const loc of locs) {
        const parsed = parseSkillUrl(loc);
        if (parsed === null) {
          // 不是 skill URL 的条目（站点地图里混着别的页面类型），跳过并计数。
          skipped += 1;
          continue;
        }
        const key = `${parsed.owner}/${parsed.repo}#${parsed.skillId}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);

        items.push({
          slug: buildSlug(parsed.owner, parsed.repo, parsed.skillId),
          title: parsed.skillId,
          url: `${this.base}/${parsed.owner}/${parsed.repo}/${parsed.skillId}`,
          publishedAt: null,
          metadata: {
            kind: "SKILL",
            sourceId: "skills.sh",
            description: null,
            frontmatter: {},
            license: null,
            repoOwner: parsed.owner,
            repoName: parsed.repo,
            repoUrl: `https://github.com/${parsed.owner}/${parsed.repo}`,
            upstreamUrl: null,
            skillPath: "",
            extraFiles: [],
            stars: 0,
            installs: 0,
            heatScore: 0,
            isOfficial: false,
            skillId: parsed.skillId,
            weeklyInstalls: [],
          },
        });
      }
    }

    if (items.length === 0) {
      throw new SourceStructureError(
        this.getName(),
        `站点地图里没有解析出任何 skill URL：${issues.join("；") || "分片都是空的"}`,
      );
    }

    if (skipped > 0) {
      issues.unshift(`跳过 ${skipped} 条不是 skill URL 的条目`);
    }

    return {
      source: "skills.sh:sitemap",
      sourceType: this.getName(),
      items,
      error: issues.length > 0 ? issues.slice(0, 20).join("；") : undefined,
    };
  }
}
