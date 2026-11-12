/**
 * Prompt 语料采集适配器（票 #15）。
 *
 * ## 一条 prompt 的完整链路
 *
 *   ① 读仓库元数据（`GET /repos/{owner}/{repo}`）
 *      → 拿 **上游自己声明的许可证**（`license.spdx_id`）与 star 数；
 *   ② 展开要采的文件路径（带 `**` 的要先列文件树）；
 *   ③ 逐个拉 raw 文件；
 *   ④ 按源解析成 prompt 列表；
 *   ⑤ **按 (仓库, 文件路径) 查许可证 override**，决定写入 `Asset.license` 的值；
 *   ⑥ 组装成 {@link RawItem}。
 *
 * ## 第 ⑤ 步是本票的关键
 *
 * GitHub 的 `license.spdx_id` 认不出「一仓两许可」与「Markdown 结构的许可声明」，
 * 会返回 `NOASSERTION` → 落 METADATA_ONLY 档 → **正文不入库**。
 * override 表（`LicenseOverride`）把这件事显式化：
 *
 *   - 不 override → 用上游声明的值（NOASSERTION）→ METADATA_ONLY；
 *   - override 命中 → 用覆盖后的值（cc0-1.0 / cc-by-4.0 …）→ FULL。
 *
 * ⚠️ **不要**在这里另写一套许可证判定 —— 全站唯一的分档入口是
 *    `resolveContentTier`（{@link ../lib/license-tier}），由写入路径调用。
 *    本文件只决定「写哪个 SPDX id 进去」。
 *
 * ## 结构变更必须显式失败
 *
 * 上游改版时（CSV 表头变了、JSON 顶层形状变了、Markdown 锚点不见了）
 * 一律抛 {@link SourceStructureError}，**绝不静默返回空数组** ——
 * 否则采集器会安静地采到 0 条，运维分不清是「这批源本来就没数据」还是「解析炸了」。
 */
import { createHash } from "node:crypto";

import { SourceConfigError, SourceStructureError } from "@/collector/errors";
import { computeHeatScore } from "@/collector/heat";
import { createHttpClient, fetchJson, fetchText, type HttpClient } from "@/collector/http";
import {
  PROMPT_SOURCES,
  findPromptSource,
  slugifyFragment,
  sourceSlugPrefix,
  type ParsedPrompt,
  type PromptSourceDefinition,
} from "@/collector/prompt-sources";
import type {
  FetchResult,
  PromptRepoSourceConfig,
  RawItem,
  SourceAdapter,
  SourceType,
} from "@/collector/types";
import { matchesAnyGlob } from "@/lib/glob";
import {
  loadLicenseOverrides,
  resolveLicenseOverride,
  type LicenseOverrideRow,
} from "@/lib/license-override";

const GITHUB_API = "https://api.github.com";
const GITHUB_RAW = "https://raw.githubusercontent.com";

/** 仓库元数据里我们关心的部分。 */
type RepoMetadata = {
  /** 上游声明的 SPDX id（GitHub 认不出来时是 `NOASSERTION`）。 */
  detectedSpdxId: string | null;
  /** star 数。 */
  stars: number;
  /** 仓库最近推送时间。 */
  pushedAt: Date | null;
};

export type PromptRepoAdapterOptions = {
  /// 注入 HTTP 客户端（测试用 fixture 驱动；生产用默认的带容错实现）。
  http?: HttpClient;
  /**
   * 许可证 override 表。
   *
   * 不给就从数据库读（{@link loadLicenseOverrides}）——
   * override 是**数据**，运营要能自己加一条，不用发版。
   */
  overrides?: LicenseOverrideRow[];
  /// GitHub API 根地址。
  apiBase?: string;
  /// GitHub raw 根地址。
  rawBase?: string;
  /// GitHub token（只发给 api.github.com）。
  token?: string | null;
};

export class PromptRepoAdapter implements SourceAdapter<PromptRepoSourceConfig> {
  private readonly http: HttpClient;
  private readonly apiBase: string;
  private readonly rawBase: string;
  private readonly token: string | null;
  private overridesPromise: Promise<LicenseOverrideRow[]> | null = null;

  constructor(options: PromptRepoAdapterOptions = {}) {
    this.http = options.http ?? createHttpClient();
    this.apiBase = (options.apiBase ?? GITHUB_API).replace(/\/+$/, "");
    this.rawBase = (options.rawBase ?? GITHUB_RAW).replace(/\/+$/, "");
    this.token = options.token ?? null;
    this.overridesPromise = options.overrides ? Promise.resolve(options.overrides) : null;
  }

  getName(): SourceType {
    return "prompt-repo";
  }

  validateConfig(config: PromptRepoSourceConfig): boolean {
    return Boolean(
      config &&
        config.type === "prompt-repo" &&
        typeof config.source === "string" &&
        config.source.trim().length > 0,
    );
  }

  async fetch(config: PromptRepoSourceConfig): Promise<FetchResult> {
    if (!this.validateConfig(config)) {
      throw new SourceConfigError(
        this.getName(),
        `配置不合法：${JSON.stringify(config)}`,
      );
    }

    const definition = findPromptSource(config.source);
    if (!definition) {
      throw new SourceConfigError(
        this.getName(),
        `未知的语料源：${config.source}（已知：${PROMPT_SOURCES.map((s) => s.id).join(", ")}）`,
      );
    }

    const issues: string[] = [];
    const overrides = await this.loadOverrides();

    // ① 仓库元数据：上游声明的许可证 + star。
    const metadata = await this.fetchRepoMetadata(definition);

    // ② 展开文件路径。
    const paths = await this.resolvePaths(definition);
    if (paths.length === 0) {
      throw new SourceStructureError(
        definition.id,
        `列出的路径一个都没匹配到文件：${definition.paths.join(", ")}`,
      );
    }

    // ③ + ④ + ⑤ + ⑥
    const items: RawItem[] = [];
    const usedSlugs = new Set<string>();
    const seenBodies = new Set<string>();
    let duplicates = 0;

    for (const path of paths) {
      const rawUrl = `${this.rawBase}/${definition.owner}/${definition.repo}/${definition.branch}/${path}`;
      const content = await fetchText(this.http, rawUrl);

      let parsed: ParsedPrompt[];
      try {
        parsed = definition.parse(path, content);
      } catch (error) {
        // 结构变更 → 显式失败。附上文件路径，方便定位。
        if (error instanceof SourceStructureError) {
          throw new SourceStructureError(definition.id, `${path}：${error.message}`);
        }
        throw error;
      }

      // 许可证 override：按 (仓库, 文件路径) 匹配。
      const license = resolveLicenseOverride(
        overrides,
        definition.id,
        path,
        metadata.detectedSpdxId,
      );
      if (license.match === "detected" && metadata.detectedSpdxId === null) {
        issues.push(`${path}：没有许可证 override，上游也没声明许可证 → 只能落 METADATA_ONLY`);
      }

      const blobUrl = `https://github.com/${definition.owner}/${definition.repo}/blob/${definition.branch}/${path}`;

      for (const prompt of parsed) {
        // 去重：正文完全一样的（归一化空白与大小写后）算同一条。
        const dedupeKey = normalizeBodyKey(prompt.body);
        if (seenBodies.has(dedupeKey)) {
          duplicates += 1;
          continue;
        }
        seenBodies.add(dedupeKey);

        const slug = buildSlug(definition, usedSlugs, prompt);
        usedSlugs.add(slug);

        items.push({
          slug,
          title: prompt.title ?? `${definition.id} 提示词`,
          url: blobUrl,
          // 正文（逐字原文）。METADATA_ONLY 档位由写入路径清空，这里不判断。
          content: prompt.body,
          metadata: {
            kind: "PROMPT",
            sourceId: definition.id,
            description: null,
            frontmatter: {},
            license: license.spdxId,
            repoOwner: definition.owner,
            repoName: definition.repo,
            repoUrl: `https://github.com/${definition.owner}/${definition.repo}`,
            upstreamUrl: blobUrl,
            skillPath: path,
            extraFiles: [],
            stars: metadata.stars,
            installs: 0,
            heatScore: computeHeatScore({ installs: 0, stars: metadata.stars }),
            isOfficial: false,
            prompt: {
              modality: prompt.modality ?? definition.modality,
              act: prompt.title,
              promptBody: prompt.body,
              forDevs: prompt.forDevs ?? null,
              contributor: prompt.contributor ?? null,
              toolTags: definition.toolTags,
              attribution: license.attribution,
              sourcePath: path,
              detectedLicense: metadata.detectedSpdxId,
            },
          },
        });
      }
    }

    if (duplicates > 0) {
      issues.push(`去重掉 ${duplicates} 条正文完全相同的提示词`);
    }

    return {
      source: definition.id,
      sourceType: this.getName(),
      items,
      error: issues.length > 0 ? issues.join("；") : undefined,
    };
  }

  /** override 表：优先用注入的，否则读数据库（只读一次，缓存住）。 */
  private async loadOverrides(): Promise<LicenseOverrideRow[]> {
    if (!this.overridesPromise) {
      this.overridesPromise = loadLicenseOverrides();
    }
    return this.overridesPromise;
  }

  /** ① 读仓库元数据。 */
  private async fetchRepoMetadata(definition: PromptSourceDefinition): Promise<RepoMetadata> {
    const url = `${this.apiBase}/repos/${definition.owner}/${definition.repo}`;
    const payload = await fetchJson<unknown>(this.http, url, {
      headers: this.apiHeaders(),
    });

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new SourceStructureError(definition.id, `仓库元数据不是对象：${url}`);
    }
    const record = payload as Record<string, unknown>;
    const license = record.license;
    const spdx =
      license && typeof license === "object" && !Array.isArray(license)
        ? (license as Record<string, unknown>).spdx_id
        : null;

    return {
      detectedSpdxId: typeof spdx === "string" && spdx.trim().length > 0 ? spdx : null,
      stars: typeof record.stargazers_count === "number" ? record.stargazers_count : 0,
      pushedAt: parseDate(record.pushed_at),
    };
  }

  /**
   * ② 展开文件路径。
   *
   * 路径里带 `**` / `*` 的要列文件树（GitHub trees API）才知道实际有哪些文件。
   */
  private async resolvePaths(definition: PromptSourceDefinition): Promise<string[]> {
    const hasGlob = definition.paths.some((pattern) => /[*?]/.test(pattern));
    if (!hasGlob) {
      return definition.paths;
    }

    const url = `${this.apiBase}/repos/${definition.owner}/${definition.repo}/git/trees/${definition.branch}?recursive=1`;
    const payload = await fetchJson<unknown>(this.http, url, { headers: this.apiHeaders() });
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new SourceStructureError(definition.id, `文件树响应不是对象：${url}`);
    }
    const record = payload as Record<string, unknown>;
    if (record.truncated === true) {
      // 被截断的文件树 = 会漏文件。宁可显式失败，也不要静默少收。
      throw new SourceStructureError(definition.id, "文件树被截断（truncated=true），结果不可信");
    }
    const tree = record.tree;
    if (!Array.isArray(tree)) {
      throw new SourceStructureError(definition.id, "文件树响应里没有 tree 数组");
    }

    const files = tree
      .filter((entry): entry is Record<string, unknown> =>
        Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
      )
      .filter((entry) => entry.type === "blob" && typeof entry.path === "string")
      .map((entry) => entry.path as string);

    const matched = files.filter((path) =>
      definition.paths.some((pattern) => matchesAnyGlob(path, [pattern])),
    );
    // 排序：保证采集顺序稳定（slug 里的序号才不会每次跑都变）。
    return matched.sort();
  }

  private apiHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "com-ai-collector",
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    return headers;
  }
}

/**
 * 构造站内唯一 slug。
 *
 * ⚠️ slug 必须由**内容**决定，不能由**位置**决定：
 * 上游往文件中间插一条 prompt，后面所有条目的序号都会平移 ——
 * 用序号做 slug 的话，重新采一轮就会多出一批重复条目。
 * 所以这里带上正文的 hash 前 8 位：内容不变 → slug 不变 → 幂等更新。
 */
function buildSlug(
  definition: PromptSourceDefinition,
  used: Set<string>,
  prompt: ParsedPrompt,
): string {
  const prefix = sourceSlugPrefix(definition.id);
  const title = prompt.title ? slugifyFragment(prompt.title, 40) : "";
  const hash = createHash("sha256").update(prompt.body, "utf8").digest("hex").slice(0, 8);
  const base = title ? `${prefix}-${title}-${hash}` : `${prefix}-${hash}`;

  let slug = base;
  let counter = 1;
  while (used.has(slug)) {
    counter += 1;
    slug = `${base}-${counter}`;
  }
  return slug;
}

/** 去重键：空白归一化 + 小写。 */
function normalizeBodyKey(body: string): string {
  return body.replace(/\s+/g, " ").trim().toLowerCase();
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
