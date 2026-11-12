/**
 * 用户发布自己的资产（票 #11）。
 *
 * ## 三条硬规矩
 *
 * 1. **写入只走 {@link writeAsset}** —— 许可证分档（FULL / METADATA_ONLY）
 *    由那条路径统一判定，本文件不自己判断许可证、不另写一套写入逻辑。
 * 2. **分档只走 {@link resolveContentTier}** —— 声明可再分发的许可 → FULL 档
 *    （存正文、生成简介）；声明无许可或限制性许可 → METADATA_ONLY 档
 *    （只存元数据与链接，**不复制原文、不生成基于原文的简介**）。
 * 3. **简介生成失败不阻断发布** —— LLM 挂了降级成模板文案，来源标记成 `TEMPLATE`。
 *
 * ## 审核状态机（spec 决策 11）
 *
 *   发布 ──命中关键词过滤──→ PENDING（审核中，已下架）
 *     │                          │
 *     │                          ├─ 运营放行 ─→ PUBLISHED（已发布）
 *     │                          └─ 运营驳回 ─→ REJECTED（已拒绝）
 *     ├─ 未命中过滤 ──────────────→ PUBLISHED（已发布，**默认可见**）
 *     │                              │
 *     │                              ├─ 被用户举报 ─→ PENDING（已下架）
 *     │                              └─ 运营判定违规 ─→ REJECTED（已下架）
 *     └─ 重新发布（同一用户同一仓库）
 *            ├─ 上次不是 REJECTED ─→ 按过滤结果重算状态
 *            └─ 上次是 REJECTED ───→ 保持 REJECTED（不自动复活，等运营放行）
 *
 * 不做全量预审队列：新发布默认可见，否则单人运营下会立刻成为瓶颈。
 */
import { Prisma, type Asset, type AssetKind, type ContentTier, type PublishStatus, type SummarySource } from "@prisma/client";

import { writeAsset, replaceAssetDependencies } from "@/lib/asset-writer";
import {
  DependencyManifestError,
  parseDependencyManifest,
  toManifestSnapshot,
  type DependencyManifest,
} from "@/lib/dependency-manifest";
import {
  DependencyResolveError,
  resolveDependencyTargets,
  type ResolvedDependency,
} from "@/lib/dependency-service";
import { normalizeSpdxId, resolveContentTier } from "@/lib/license-tier";
import { filterPublishText } from "@/lib/publish-keyword-filter";
import { prisma } from "@/lib/prisma";
import { buildInstallCommands } from "@/lib/skill-install";
import { recordVersion } from "@/lib/version-store";
import {
  type SummaryDraft,
  type SummaryGenerator,
  templateSummaryDraft,
} from "@/lib/summary-generator";
import { computeContentHash, generateSummary } from "@/lib/summary-service";

/** 用户发布的资产在 Asset 表上的来源标识。 */
export const USER_PUBLISHED_SOURCE_ID = "user";

export type PublishErrorCode =
  /// 入参不合法（缺字段、仓库地址不是 GitHub 仓库……）。
  | "INVALID_INPUT"
  /// 这个仓库已经在市场里了（被别人发布过，或已被采集收录）。
  | "SLUG_TAKEN"
  /// 依赖清单格式非法（票 #17）。消息里有字段路径与行列位置。
  | "INVALID_MANIFEST"
  /// 依赖声明解析不了（目标不存在 / 自己依赖自己 / 类型对不上）（票 #17）。
  | "INVALID_DEPENDENCY";

/** 带错误码的发布错误，路由据此映射 HTTP 状态码。 */
export class PublishError extends Error {
  readonly code: PublishErrorCode;

  constructor(code: PublishErrorCode, message: string) {
    super(message);
    this.name = "PublishError";
    this.code = code;
  }
}

export type PublishAssetInput = {
  /// 发布者（已通过邮箱验证的账号）。
  userId: string;
  /// 资产类型。
  kind: AssetKind;
  /// 展示名。
  displayName: string;
  /// 仓库地址：`https://github.com/owner/repo` 或 `owner/repo`。
  repoUrl: string;
  /// 发布者自己声明的 SPDX 许可证 id（null = 未声明）。
  license: string | null;
  /// 发布者自己写的简介（一句话）。
  description: string;
  /// 可选：资产正文（SKILL.md / MCP 配置 / 提示词）。
  ///
  /// ⚠️ 只有声明了允许再分发的许可才会被保存；METADATA_ONLY 档位由
  ///    写入路径与数据库触发器清空 —— **这是设计如此**（站内不复制原文）。
  contentBody?: string | null;
  /// 可选：资产在仓库内的路径（如 `skills/pdf/SKILL.md`）。
  skillPath?: string | null;
  /// 可选：发布者声明的版本号（平台 semver）。**二期（#16）预留**，一期只存不用。
  version?: string | null;
  /// 可选：仓库内依赖清单的相对路径（清单在仓库里的位置，平台约定的文件名）。
  manifestPath?: string | null;
  /// 可选：依赖清单正文（票 #17）。平台约定的格式（YAML；JSON 是子集）。
  ///
  /// 传了 = 以这份清单为准（**整体替换**已有依赖关系，空清单 = 解除全部依赖）；
  /// 没传 = 不动已有的依赖关系（重新发布不该把上次声明的依赖抹掉）。
  manifest?: string | null;
};

export type PublishAssetResult = {
  /// 写入后的资产。
  asset: Asset;
  /// 发布记录（审核状态机所在）。
  publicationId: string;
  /// 审核状态。
  status: PublishStatus;
  /// 内容档位。
  contentTier: ContentTier;
  /// 简介来源标记（LLM / HUMAN / TEMPLATE）。
  summarySource: SummarySource | null;
  /// **实际落库**的中文简介（接口回显用这个，别回显草稿）。
  summaryZh: string;
  /// **实际落库**的「何时用」；METADATA_ONLY 档位一定是 null。
  whenToUse: string | null;
  /// **实际落库**的「怎么用」；METADATA_ONLY 档位一定是 null。
  howToUse: string | null;
  /// 简介初稿本身（供接口回显与页面展示）。
  draft: SummaryDraft;
  /// 是否命中自动关键词过滤。
  filtered: boolean;
  /// **本次解析并写入的依赖关系**（票 #17）：依赖了谁。
  ///
  /// 没传清单时是空数组 —— 注意这不代表「解除了依赖」：
  /// 没传清单 = 不动已有关系（见 {@link PublishAssetInput.manifest}）。
  dependencies: ResolvedDependency[];
};

/** 仓库引用（owner / name / 规范化的仓库地址）。 */
export type RepoRef = {
  owner: string;
  name: string;
  url: string;
};

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

/** 仓库路径片段是否合法（GitHub 的 owner / repo 命名规则）。 */
function isRepoSegment(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && !value.startsWith(".") && !value.endsWith(".");
}

/**
 * 解析仓库地址。
 *
 * 接受两种写法：`https://github.com/owner/repo` 与 `owner/repo`。
 * 解析不出来返回 null（调用方报 400）。
 */
export function parseRepoRef(input: string): RepoRef | null {
  const raw = (input ?? "").trim();
  if (raw.length === 0) {
    return null;
  }

  if (/^https?:\/\//i.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) {
      return null;
    }
    const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
    if (segments.length < 2) {
      return null;
    }
    const owner = segments[0];
    const name = segments[1].replace(/\.git$/i, "");
    if (!isRepoSegment(owner) || !isRepoSegment(name)) {
      return null;
    }
    return { owner, name, url: `https://github.com/${owner}/${name}` };
  }

  const segments = raw.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 2) {
    return null;
  }
  const owner = segments[0];
  const name = segments[1].replace(/\.git$/i, "");
  if (!isRepoSegment(owner) || !isRepoSegment(name)) {
    return null;
  }
  return { owner, name, url: `https://github.com/${owner}/${name}` };
}

/**
 * 用户发布资产的 slug：`owner-repo`。
 *
 * 归一化规则与采集器的 `buildSlug` 一致（全小写、非字母数字折成连字符），
 * 只是不带 skill 名 —— 用户发布的是**整个仓库**。
 */
export function buildPublishSlug(owner: string, name: string): string {
  return `${owner}-${name}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** 允许发布的资产类型。 */
const PUBLISHABLE_KINDS: readonly AssetKind[] = ["SKILL", "MCP", "PROMPT"];

/**
 * 发布一个资产。
 *
 * 依赖注入：{@link PublishAssetInput} 之外可以传一个假的简介生成器
 * （spec 的 port 约定：测试注入确定性假实现，断言流水线存下了它返回的内容）。
 */
export async function publishAsset(
  input: PublishAssetInput,
  deps: { generator?: SummaryGenerator } = {},
): Promise<PublishAssetResult> {
  // ─── 1. 入参校验 ───────────────────────────────────────────────────
  const kind = input.kind;
  if (!PUBLISHABLE_KINDS.includes(kind)) {
    throw new PublishError("INVALID_INPUT", "资产类型只能是 SKILL、MCP 或 PROMPT。");
  }

  const displayName = (input.displayName ?? "").trim();
  if (displayName.length === 0) {
    throw new PublishError("INVALID_INPUT", "请填写资产名称。");
  }
  if (displayName.length > 120) {
    throw new PublishError("INVALID_INPUT", "资产名称太长了（120 字以内）。");
  }

  const description = (input.description ?? "").trim();
  if (description.length === 0) {
    throw new PublishError("INVALID_INPUT", "请写一句简介，说明这个资产是干什么的。");
  }
  if (description.length > 2000) {
    throw new PublishError("INVALID_INPUT", "简介太长了（2000 字以内）。");
  }

  const repo = parseRepoRef(input.repoUrl ?? "");
  if (!repo) {
    throw new PublishError(
      "INVALID_INPUT",
      "仓库地址不合法：请填 GitHub 仓库地址（如 https://github.com/owner/repo）。",
    );
  }

  // ─── 2. 分档（唯一入口：resolveContentTier）─────────────────────────
  const license = normalizeSpdxId(input.license);
  const contentTier = resolveContentTier(license);

  // ─── 3. slug 与冲突 ────────────────────────────────────────────────
  const slug = buildPublishSlug(repo.owner, repo.name);
  if (slug.length === 0) {
    throw new PublishError("INVALID_INPUT", "仓库地址不合法。");
  }

  const existing = await prisma.asset.findUnique({
    where: { slug },
    include: { publishedBy: true },
  });

  let previousStatus: PublishStatus | null = null;
  if (existing) {
    const mine = existing.publishedBy.find((row) => row.userId === input.userId);
    if (!mine) {
      const byOthers = existing.publishedBy.length > 0;
      throw new PublishError(
        "SLUG_TAKEN",
        byOthers
          ? "这个仓库已经由其他用户发布过了。"
          : "这个仓库已经在市场里了，不需要重复发布。",
      );
    }
    previousStatus = mine.status;
  }

  // ─── 3.5 依赖清单（票 #17）──────────────────────────────────────────
  //
  // ⚠️ 顺序很重要：**先解析、先把目标查出来，全部通过之后才写库**。
  //    清单格式非法或依赖目标不存在时，整条发布在这里被拒 ——
  //    不会留下「资产写进去了、依赖没写」这种半截数据。
  //
  // 没传清单 = 不动已有的依赖关系（重新发布不该把上次声明的依赖抹掉）。
  const manifestText = (input.manifest ?? "").trim();
  const hasManifest = manifestText.length > 0;

  let manifest: DependencyManifest | null = null;
  let resolvedDependencies: ResolvedDependency[] = [];

  if (hasManifest) {
    try {
      manifest = parseDependencyManifest(manifestText);
    } catch (error) {
      if (error instanceof DependencyManifestError) {
        throw new PublishError("INVALID_MANIFEST", error.message);
      }
      throw error;
    }

    try {
      resolvedDependencies = await resolveDependencyTargets(manifest.dependencies, {
        selfSlug: slug,
      });
    } catch (error) {
      if (error instanceof DependencyResolveError) {
        throw new PublishError("INVALID_DEPENDENCY", error.message);
      }
      throw error;
    }
  }

  // ─── 4. 简介初稿 ───────────────────────────────────────────────────
  const generatorInput = {
    kind,
    displayName,
    contentBody: input.contentBody ?? null,
    // 哈希简介所依据的那段文字：有正文用正文，没有正文用作者自述。
    // 这条规则与采集入库、批量重跑**完全一致** —— 三条路径算出来的
    // 内容 hash 一样，缓存才能互通（票 #7）。
    contentHash: computeContentHash(input.contentBody ?? description),
    sourceId: USER_PUBLISHED_SOURCE_ID,
    description,
    repoOwner: repo.owner,
    repoName: repo.name,
    license,
  };

  let draft: SummaryDraft;
  let summarySource: SummarySource;
  let whenToUse: string | null = null;
  let howToUse: string | null = null;

  if (contentTier === "FULL") {
    // 可再分发：可以基于原文生成简介。
    // 走带缓存的生成（票 #7）：同一份内容重复发布不会重复调模型。
    const generated = await generateSummary(
      generatorInput,
      deps.generator ? { generator: deps.generator } : {},
    );
    draft = generated.draft;
    summarySource = draft.source;
    whenToUse = draft.whenToUse;
    howToUse = draft.howToUse;
  } else {
    // METADATA_ONLY：**不生成基于原文的简介**（站内既不复制原文，也不据原文写简介）。
    // 保留发布者自己写的那句话 —— spec 决策 6 允许「自行撰写的一句话描述」。
    draft = templateSummaryDraft(generatorInput);
    summarySource = "HUMAN";
  }

  const summaryZh = contentTier === "FULL" ? draft.summaryZh : description;

  // ─── 5. 自动关键词过滤（只过滤用户自己写的字）──────────────────────
  const filter = filterPublishText(`${displayName}\n${description}`);

  let status: PublishStatus;
  if (previousStatus === "REJECTED") {
    // 被拒绝过的资产不因为「重新发布」自动复活 —— 等运营放行。
    status = "REJECTED";
  } else {
    status = filter.hit ? "PENDING" : "PUBLISHED";
  }

  // ─── 6. 写资产（唯一写入路径：writeAsset）──────────────────────────
  const asset = await writeAsset({
    kind,
    slug,
    displayName,
    license,
    contentBody: input.contentBody ?? null,
    summaryZh,
    summarySource,
    // 「何时用 / 怎么用」的主表值（权威）；扩展表里那份是它的镜像。
    whenToUse,
    howToUse,
    repoOwner: repo.owner,
    repoName: repo.name,
    repoUrl: repo.url,
    upstreamUrl: repo.url,
    sourceId: USER_PUBLISHED_SOURCE_ID,
    publishedAt: new Date(),
    lastSyncedAt: new Date(),
    isOfficial: false,
    // 不传版本号 = 保留原来的版本号（重新发布不该把版本抹掉）。
    // 注意用 `?? undefined` 而不是 `?? null`：null 会被当成「显式清空」。
    currentVersion: input.version ?? undefined,
    detail: buildDetail(kind, {
      displayName,
      description,
      owner: repo.owner,
      name: repo.name,
      skillPath: input.skillPath ?? null,
      whenToUse,
      howToUse,
    }),
  });

  // ─── 7. 发布记录（审核状态机所在）──────────────────────────────────
  //
  // 依赖清单的解析快照与内容 hash（票 #17）：
  // 没传清单 = 不动这两列（undefined = 这一列不更新）。
  const manifestSnapshot: Prisma.InputJsonValue | undefined = manifest
    ? (toManifestSnapshot(manifest) as Prisma.InputJsonValue)
    : undefined;
  const manifestHash = hasManifest ? computeContentHash(manifestText) : undefined;

  const publication = await prisma.userPublishedAsset.upsert({
    where: { userId_assetId: { userId: input.userId, assetId: asset.id } },
    create: {
      userId: input.userId,
      assetId: asset.id,
      note: description,
      status,
      filteredReason: filter.reason,
      reportedCount: 0,
      // #16 起这列真的会被消费（平台 semver 版本）。不填版本号 = 不动它，
      // 重新发布不该把上次声明的版本抹掉。
      latestVersion: input.version ?? undefined,
      // 同理：清单路径不填 = 不动它（#17 起这列指向真实的依赖清单）。
      manifestPath: input.manifestPath ?? null,
      // 依赖清单的解析快照与内容 hash（票 #17）。
      // 没传清单 = 不动这两列（undefined = 不更新这一列）。
      dependencyManifest: manifestSnapshot,
      manifestHash,
    },
    update: {
      note: description,
      status,
      filteredReason: filter.reason,
      // 审核意见**不清空** —— 发布者始终能看到运营最后一次的反馈。
      latestVersion: input.version ?? undefined,
      manifestPath: input.manifestPath ?? undefined,
      // 只在**这次传了清单**时更新快照与 hash。
      dependencyManifest: manifestSnapshot,
      manifestHash,
    },
  });

  // ─── 8. 依赖关系（票 #17）──────────────────────────────────────────
  //
  // 依赖关系是「清单的直接投影」：传了清单就以清单为准（整体替换，
  // 空清单 = 解除全部依赖）；没传清单就一行都不动。
  if (hasManifest) {
    await replaceAssetDependencies(
      asset.id,
      resolvedDependencies.map((dependency) => ({
        toId: dependency.assetId,
        // 依赖目标是站内资产 → 类型就是它自己的类型。
        kind: dependency.kind,
        constraint: dependency.constraint,
      })),
    );
  }

  // ─── 8. 版本行（票 #16）────────────────────────────────────────────
  //
  // 上游版本与平台发布版本**共用一张 `AssetVersion` 表**，靠 `origin` 区分来源。
  // 平台发布的版本号就是发布者声明的 semver。
  const platformVersion = input.version?.trim() ?? "";
  if (platformVersion.length > 0) {
    await recordVersion({
      assetId: asset.id,
      version: platformVersion,
      origin: "PLATFORM",
      changelog: `发布版本 ${platformVersion}`,
      contentHash: generatorInput.contentHash,
    });
  }

  // 落库后**回读**一次：数据库触发器（许可证分层的兜底强制执行）可能清掉
  // 正文 / LLM 简介 / whenToUse —— 接口回显的必须是「实际存下来的」，
  // 而不是「我们打算存的」。
  const stored = await prisma.asset.findUniqueOrThrow({
    where: { id: asset.id },
    include: { skillDetail: true },
  });
  return {
    asset: stored,
    publicationId: publication.id,
    status: publication.status,
    contentTier: stored.contentTier,
    summarySource: stored.summarySource,
    // 回显**落库**的值，不回显草稿 —— METADATA_ONLY 档位落库的简介是
    // 用户自己写的那句话，「何时用 / 怎么用」是空的。
    summaryZh: stored.summaryZh ?? summaryZh,
    // 「何时用 / 怎么用」读主表那份（权威值）；扩展表里的是它的镜像。
    whenToUse: stored.whenToUse,
    howToUse: stored.howToUse,
    draft,
    filtered: filter.hit,
    dependencies: resolvedDependencies,
  };
}

/** 按 kind 组装 1:1 扩展表数据。 */
function buildDetail(
  kind: AssetKind,
  context: {
    displayName: string;
    description: string;
    owner: string;
    name: string;
    skillPath: string | null;
    whenToUse: string | null;
    howToUse: string | null;
  },
) {
  if (kind === "SKILL") {
    const installCmds = buildInstallCommands({
      owner: context.owner,
      repo: context.name,
      skillName: context.displayName,
    });
    return {
      skill: {
        frontmatter: { name: context.displayName, description: context.description },
        whenToUse: context.whenToUse,
        howToUse: context.howToUse,
        installCmds,
        hosts: Object.keys(installCmds),
        skillPath: context.skillPath,
      },
    };
  }

  if (kind === "MCP") {
    return { mcp: { transport: null, envVars: [], ports: [] } };
  }

  return {
    prompt: {
      modality: "TEXT" as const,
      act: context.displayName,
      forDevs: context.description,
      contributor: null,
    },
  };
}
