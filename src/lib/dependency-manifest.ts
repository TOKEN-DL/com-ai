/**
 * 依赖清单（平台约定的 manifest 格式）的解析（票 #17）。
 *
 * ## 清单格式（平台约定）
 *
 * 清单是一个 YAML 文档（JSON 是 YAML 的子集，所以 `com-ai.manifest.json` 也能解析）。
 * 顶层只认两个键：
 *
 * ```yaml
 * # com-ai.manifest.yaml
 * version: 1
 * dependencies:
 *   - slug: pdf-batch-processor   # 被依赖资产在平台上的 slug（必填）
 *     kind: SKILL                 # 被依赖资产的类型（可选，用于交叉校验）
 *     version: ">=1.2.0"          # 版本约束（可选，**只展示，不做求解**）
 *   - slug: pdf-mcp-server
 * ```
 *
 * ### 为什么是 YAML 而不是自由文本
 *
 * - 票里写的是「平台约定的清单格式」，不是自由文本：自由文本没法机器解析，
 *   也就没法「解析入库」，更谈不上「格式非法时给出明确错误提示」。
 * - YAML 允许注释与省略字段，写在仓库里给人看也读得懂；
 *   JSON 是它的子集，想写 JSON 的人也不会被挡住。
 * - 仓库里已经有 `yaml` 这个运行时依赖 —— 不新增任何依赖。
 *
 * ## 为什么依赖标识只用 slug
 *
 * 依赖目标是**平台上的另一个资产**，用平台 slug 标识最直接：
 * slug 全站唯一、可反查（详情页要显示「被谁依赖」）、也是站内链接的天然主键。
 * 仓库地址（owner/repo）不是站内主键，同一个仓库可能被多个条目收录，
 * 用它标识会把「依赖某个资产」变成「依赖某个来源」，语义会跑偏。
 *
 * ## 版本约束只展示、不求解
 *
 * spec 决策 1 明确「永久不做依赖自动求解器」。所以 `version` 字段**只做展示**：
 * 平台不解析它、不比较它、不因为它拒绝任何声明。
 *
 * ## 格式非法必须报错，不能静默忽略
 *
 * 验收标准写死了这一点。所以这里**收集全部问题**再一次性抛出
 * {@link DependencyManifestError}：每条问题都带「字段路径 + 行列位置 + 期望什么」，
 * 调用方据此拒绝入库 —— 半截写入比报错更糟。
 */
import { LineCounter, isMap, isScalar, isSeq, parseDocument } from "yaml";

/** 平台约定的清单文件名（发布表单里给发布者的默认建议）。 */
export const DEFAULT_MANIFEST_FILENAME = "com-ai.manifest.yaml";

/** 清单格式版本（当前只认 1）。 */
export const DEPENDENCY_MANIFEST_VERSION = 1;

/** 清单里能声明的被依赖资产类型（平台的资产类型）。 */
export const DEPENDENCY_TARGET_KINDS = ["SKILL", "MCP", "PROMPT"] as const;

export type DependencyTargetKind = (typeof DEPENDENCY_TARGET_KINDS)[number];

/** 一条依赖声明。 */
export type DependencyDeclaration = {
  /// 被依赖资产在平台上的 slug。
  slug: string;
  /// 声明的被依赖资产类型（可选）。给了就与实际类型交叉校验。
  kind?: DependencyTargetKind;
  /// 版本约束（可选）。**只展示，不求解**（spec 决策 1：不做依赖求解器）。
  version?: string;
};

/** 解析出来的清单。 */
export type DependencyManifest = {
  /// 清单格式版本。
  version: number;
  /// 依赖声明列表（按声明顺序；已去重 —— 重复声明是错误，不在这里去）。
  dependencies: DependencyDeclaration[];
};

/** 一处格式问题。 */
export type DependencyManifestIssue = {
  /// 字段路径（如 `dependencies[0].slug`）；语法级错误没有路径。
  path: string | null;
  /// 1 起的行号。
  line: number | null;
  /// 1 起的列号。
  column: number | null;
  /// 这条问题是什么（期望什么、实际是什么）。
  message: string;
};

/**
 * 依赖清单格式错误。
 *
 * 消息里已经把「哪个字段、哪一行、期望什么」讲清楚了，接口直接把它回给发布者。
 */
export class DependencyManifestError extends Error {
  readonly issues: DependencyManifestIssue[];

  constructor(issues: DependencyManifestIssue[]) {
    super(formatIssues(issues));
    this.name = "DependencyManifestError";
    this.issues = issues;
  }
}

/** 顶层允许出现的键。 */
const TOP_LEVEL_KEYS = ["version", "dependencies"] as const;

/** 一条依赖声明里允许出现的键。 */
const DECLARATION_KEYS = ["slug", "kind", "version"] as const;

/**
 * 平台 slug 的形状。
 *
 * 站内 slug 由 `buildSlug` / `buildPublishSlug` 生成：小写字母数字 + 连字符。
 * 这里只做形状校验（不查库），真正的「存不存在」是解析之后那一步的事。
 */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 把问题列表拼成一条人话消息。 */
function formatIssues(issues: DependencyManifestIssue[]): string {
  const header =
    issues.length === 1 ? "依赖清单格式有 1 处问题：" : `依赖清单格式有 ${issues.length} 处问题：`;
  const lines = issues.map((issue, index) => {
    const where = [
      issue.path,
      issue.line !== null ? `第 ${issue.line} 行` : null,
      issue.column !== null ? `第 ${issue.column} 列` : null,
    ]
      .filter((part): part is string => part !== null)
      .join("，");
    return `${index + 1}. ${where ? `${where}：` : ""}${issue.message}`;
  });
  return `${header}\n${lines.join("\n")}`;
}

/** 把偏移量换算成「第几行第几列」（1 起）。 */
function lineCol(lineCounter: LineCounter, offset: number): { line: number; column: number } {
  const pos = lineCounter.linePos(offset);
  return { line: pos.line, column: pos.col };
}

/**
 * 语法错误的位置。
 *
 * ⚠️ `prettyErrors: false` 时 YAML 解析器**不会**给错误附上 `linePos`
 *    （位置信息是「美化过的错误消息」的一部分）。所以这里用错误自己的
 *    偏移量 `pos` 换算出行列 —— 否则格式非法时只能说「解析失败」，
 *    发布者根本不知道错在哪一行。
 */
function errorPosition(
  error: { pos?: number[]; linePos?: { line: number; col: number }[] },
  lineCounter: LineCounter,
): { line: number | null; column: number | null } {
  if (error.pos && typeof error.pos[0] === "number") {
    const position = lineCol(lineCounter, error.pos[0]);
    return { line: position.line, column: position.column };
  }
  const linePos = error.linePos?.[0];
  if (linePos) {
    return { line: linePos.line, column: linePos.col };
  }
  return { line: null, column: null };
}

/** 节点在原文里的起始偏移（拿不到就返回 null）。 */
function nodeOffset(node: unknown): number | null {
  if (node && typeof node === "object" && Array.isArray((node as { range?: number[] }).range)) {
    const range = (node as { range: number[] }).range;
    return typeof range[0] === "number" ? range[0] : null;
  }
  return null;
}

/** 标量的原始类型名（写进错误消息，让发布者知道「实际是什么」）。 */
function scalarTypeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "数组";
  switch (typeof value) {
    case "string":
      return "字符串";
    case "number":
      return "数字";
    case "boolean":
      return "布尔值";
    default:
      return typeof value;
  }
}

/** 标量的字面量（短的就直接写出来，长的截断）。 */
function scalarLiteral(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    return value.length > 40 ? `${value.slice(0, 40)}…` : value;
  }
  return String(value);
}

/**
 * 解析依赖清单。
 *
 * 纯函数：只吃文本、只吐清单（或清单错误），不碰数据库 —— 这样格式校验
 * 能在任何时候单独跑，也能在入库之前跑完（格式不对就整条拒绝，不半截写入）。
 *
 * @param text 清单正文（YAML；JSON 也行）。
 * @throws {DependencyManifestError} 清单格式非法（消息里带字段路径与行列位置）。
 */
export function parseDependencyManifest(text: string): DependencyManifest {
  const issues: DependencyManifestIssue[] = [];
  const lineCounter = new LineCounter();

  const doc = parseDocument(text, { lineCounter, prettyErrors: false });

  // 语法级错误：位置由解析器给的偏移量换算而来（见 {@link errorPosition}）。
  for (const error of doc.errors) {
    const position = errorPosition(error, lineCounter);
    issues.push({
      path: null,
      line: position.line,
      column: position.column,
      message: `清单不是合法的 YAML：${error.message.split("\n")[0]}`,
    });
  }
  if (issues.length > 0) {
    throw new DependencyManifestError(issues);
  }

  const root = doc.contents;
  if (root === null || root === undefined) {
    throw new DependencyManifestError([
      { path: null, line: null, column: null, message: "清单是空的：至少要写 dependencies 列表。" },
    ]);
  }

  if (!isMap(root)) {
    const offset = nodeOffset(root);
    const position = offset === null ? null : lineCol(lineCounter, offset);
    throw new DependencyManifestError([
      {
        path: null,
        line: position?.line ?? null,
        column: position?.column ?? null,
        message: `清单顶层必须是一个键值对对象，实际是${scalarTypeName(
          isScalar(root) ? root.value : undefined,
        )}。`,
      },
    ]);
  }

  // ─── 顶层键 ────────────────────────────────────────────────────────
  const rootOffset = nodeOffset(root);
  const rootPosition = rootOffset === null ? null : lineCol(lineCounter, rootOffset);

  for (const pair of root.items) {
    const key = isScalar(pair.key) ? String(pair.key.value) : "";
    if (!(TOP_LEVEL_KEYS as readonly string[]).includes(key)) {
      issues.push({
        path: key,
        line: rootPosition?.line ?? null,
        column: rootPosition?.column ?? null,
        message: `顶层不允许这个键（只认 ${TOP_LEVEL_KEYS.join(" / ")}）。`,
      });
    }
  }

  // ─── version ───────────────────────────────────────────────────────
  let version = DEPENDENCY_MANIFEST_VERSION;
  const versionNode = root.get("version", true);
  if (versionNode !== undefined && versionNode !== null) {
    const offset = nodeOffset(versionNode);
    const position = offset === null ? null : lineCol(lineCounter, offset);
    if (!isScalar(versionNode)) {
      issues.push({
        path: "version",
        line: position?.line ?? null,
        column: position?.column ?? null,
        message: "version 必须是数字。",
      });
    } else if (typeof versionNode.value !== "number") {
      issues.push({
        path: "version",
        line: position?.line ?? null,
        column: position?.column ?? null,
        message: `version 必须是数字，实际是${scalarTypeName(versionNode.value)}「${scalarLiteral(
          versionNode.value,
        )}」。`,
      });
    } else if (versionNode.value !== DEPENDENCY_MANIFEST_VERSION) {
      issues.push({
        path: "version",
        line: position?.line ?? null,
        column: position?.column ?? null,
        message: `只支持 version ${DEPENDENCY_MANIFEST_VERSION}，实际是 ${versionNode.value}。`,
      });
    } else {
      version = versionNode.value;
    }
  }

  // ─── dependencies ──────────────────────────────────────────────────
  const dependencies: DependencyDeclaration[] = [];
  const seen = new Map<string, number>();

  const dependenciesNode = root.get("dependencies", true);
  if (dependenciesNode === undefined || dependenciesNode === null) {
    // 没写 dependencies = 没有依赖（合法）。
  } else if (!isSeq(dependenciesNode)) {
    const offset = nodeOffset(dependenciesNode);
    const position = offset === null ? null : lineCol(lineCounter, offset);
    issues.push({
      path: "dependencies",
      line: position?.line ?? null,
      column: position?.column ?? null,
      message: `dependencies 必须是一个列表，实际是${scalarTypeName(
        isScalar(dependenciesNode) ? dependenciesNode.value : undefined,
      )}。`,
    });
  } else {
    dependenciesNode.items.forEach((item, index) => {
      const path = `dependencies[${index}]`;
      const itemOffset = nodeOffset(item);
      const itemPosition = itemOffset === null ? null : lineCol(lineCounter, itemOffset);

      if (!isMap(item)) {
        issues.push({
          path,
          line: itemPosition?.line ?? null,
          column: itemPosition?.column ?? null,
          message: `每条依赖必须是一个对象（写成 "- slug: xxx"），实际是${scalarTypeName(
            isScalar(item) ? item.value : undefined,
          )}。`,
        });
        return;
      }

      // 声明里不允许的键
      for (const pair of item.items) {
        const key = isScalar(pair.key) ? String(pair.key.value) : "";
        if (!(DECLARATION_KEYS as readonly string[]).includes(key)) {
          const keyOffset = nodeOffset(pair.key);
          const keyPosition = keyOffset === null ? null : lineCol(lineCounter, keyOffset);
          issues.push({
            path: `${path}.${key}`,
            line: keyPosition?.line ?? itemPosition?.line ?? null,
            column: keyPosition?.column ?? itemPosition?.column ?? null,
            message: `依赖声明里不允许这个键（只认 ${DECLARATION_KEYS.join(" / ")}）。`,
          });
        }
      }

      // slug（必填）
      let slug: string | null = null;
      const slugNode = item.get("slug", true);
      if (slugNode === undefined || slugNode === null) {
        issues.push({
          path: `${path}.slug`,
          line: itemPosition?.line ?? null,
          column: itemPosition?.column ?? null,
          message: "缺少 slug：每条依赖都要写被依赖资产在平台上的 slug。",
        });
      } else {
        const offset = nodeOffset(slugNode);
        const position = offset === null ? itemPosition : lineCol(lineCounter, offset);
        if (!isScalar(slugNode) || typeof slugNode.value !== "string") {
          issues.push({
            path: `${path}.slug`,
            line: position?.line ?? null,
            column: position?.column ?? null,
            message: `slug 必须是字符串，实际是${scalarTypeName(
              isScalar(slugNode) ? slugNode.value : undefined,
            )}。`,
          });
        } else {
          const normalized = slugNode.value.trim().toLowerCase();
          if (normalized.length === 0) {
            issues.push({
              path: `${path}.slug`,
              line: position?.line ?? null,
              column: position?.column ?? null,
              message: "slug 不能是空字符串。",
            });
          } else if (!SLUG_PATTERN.test(normalized)) {
            issues.push({
              path: `${path}.slug`,
              line: position?.line ?? null,
              column: position?.column ?? null,
              message: `slug 的格式不对：只能是小写字母、数字与连字符（如 pdf-batch-processor），实际是「${scalarLiteral(
                slugNode.value,
              )}」。`,
            });
          } else {
            slug = normalized;
          }
        }
      }

      // kind（可选）
      let kind: DependencyTargetKind | undefined;
      const kindNode = item.get("kind", true);
      if (kindNode !== undefined && kindNode !== null) {
        const offset = nodeOffset(kindNode);
        const position = offset === null ? itemPosition : lineCol(lineCounter, offset);
        if (!isScalar(kindNode) || typeof kindNode.value !== "string") {
          issues.push({
            path: `${path}.kind`,
            line: position?.line ?? null,
            column: position?.column ?? null,
            message: `kind 必须是字符串，实际是${scalarTypeName(
              isScalar(kindNode) ? kindNode.value : undefined,
            )}。`,
          });
        } else {
          const normalized = kindNode.value.trim().toUpperCase();
          if (!(DEPENDENCY_TARGET_KINDS as readonly string[]).includes(normalized)) {
            issues.push({
              path: `${path}.kind`,
              line: position?.line ?? null,
              column: position?.column ?? null,
              message: `kind 只能是 ${DEPENDENCY_TARGET_KINDS.join(" / ")} 之一，实际是「${scalarLiteral(
                kindNode.value,
              )}」。`,
            });
          } else {
            kind = normalized as DependencyTargetKind;
          }
        }
      }

      // version（可选，只展示不求解）
      let versionConstraint: string | undefined;
      const versionNode = item.get("version", true);
      if (versionNode !== undefined && versionNode !== null) {
        const offset = nodeOffset(versionNode);
        const position = offset === null ? itemPosition : lineCol(lineCounter, offset);
        if (!isScalar(versionNode) || typeof versionNode.value !== "string") {
          issues.push({
            path: `${path}.version`,
            line: position?.line ?? null,
            column: position?.column ?? null,
            message: `version 必须是字符串（版本约束只展示、不求解），实际是${scalarTypeName(
              isScalar(versionNode) ? versionNode.value : undefined,
            )}。`,
          });
        } else {
          const trimmed = versionNode.value.trim();
          if (trimmed.length === 0) {
            issues.push({
              path: `${path}.version`,
              line: position?.line ?? null,
              column: position?.column ?? null,
              message: "version 不能是空字符串（不写就整条省掉）。",
            });
          } else {
            versionConstraint = trimmed;
          }
        }
      }

      if (slug === null) {
        return;
      }

      // 重复声明 → 报错（平台的依赖关系是一对一的关系，重复声明没有意义）。
      const firstIndex = seen.get(slug);
      if (firstIndex !== undefined) {
        issues.push({
          path: `${path}.slug`,
          line: itemPosition?.line ?? null,
          column: itemPosition?.column ?? null,
          message: `依赖目标「${slug}」重复声明了（第一次在 dependencies[${firstIndex}]）。`,
        });
        return;
      }
      seen.set(slug, index);

      dependencies.push({
        slug,
        ...(kind ? { kind } : {}),
        ...(versionConstraint ? { version: versionConstraint } : {}),
      });
    });
  }

  if (issues.length > 0) {
    throw new DependencyManifestError(issues);
  }

  return { version, dependencies };
}

/**
 * 清单的规范化快照（落进 `UserPublishedAsset.dependencyManifest`）。
 *
 * 存「解析之后」的结构而不是原文：原文是发布者的，解析结果才是平台的；
 * 复算依赖关系时用这份快照，不用再解析一遍原文。
 */
export function toManifestSnapshot(manifest: DependencyManifest): DependencyDeclaration[] {
  return manifest.dependencies.map((entry) => ({
    slug: entry.slug,
    ...(entry.kind ? { kind: entry.kind } : {}),
    ...(entry.version ? { version: entry.version } : {}),
  }));
}
