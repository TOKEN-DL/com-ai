/**
 * 依赖关系的服务层（票 #17）。
 *
 * 职责有两块：
 *
 * 1. **解析**：把清单里的声明（slug）变成站内资产（assetId），
 *    顺便把「依赖目标不存在」「自己依赖自己」「类型对不上」这些
 *    情况变成**带明确说明的错误** —— 验收标准要求「不静默忽略」。
 * 2. **读取**：详情页要展示「依赖了谁 / 被谁依赖」，出边与入边各一份。
 *
 * ## 为什么不放一个「待解析」的依赖
 *
 * `AssetDependency.toId` 是指向 `Asset` 的外键（NOT NULL），
 * 也就是说**平台没法记录一个还不存在的依赖目标**。
 * 既然存不下，就不能悄悄丢掉 —— 所以目标不存在时整条发布被拒，
 * 发布者按提示先把它发布上来。
 *
 * ## 版本约束只展示
 *
 * spec 决策 1：「永久不做依赖自动求解器」。所以约束原样存、原样显示，
 * 平台不解析它、不比较它。
 */
import type { AssetKind } from "@prisma/client";

import type { DependencyDeclaration } from "@/lib/dependency-manifest";
import { prisma } from "@/lib/prisma";

/** 依赖解析失败的原因。 */
export type DependencyResolveErrorCode =
  /// 依赖目标在平台上不存在。
  | "UNKNOWN_TARGET"
  /// 资产依赖了自己。
  | "SELF_DEPENDENCY"
  /// 清单里声明的类型与目标资产的真实类型对不上。
  | "KIND_MISMATCH";

/** 依赖解析错误（消息已经是给发布者看的中文说明）。 */
export class DependencyResolveError extends Error {
  readonly code: DependencyResolveErrorCode;
  /// 出问题的那个依赖目标 slug。
  readonly slug: string;

  constructor(code: DependencyResolveErrorCode, slug: string, message: string) {
    super(message);
    this.name = "DependencyResolveError";
    this.code = code;
    this.slug = slug;
  }
}

/** 解析出来的依赖目标。 */
export type ResolvedDependency = {
  /// 被依赖资产的 id（`AssetDependency.toId`）。
  assetId: string;
  /// 被依赖资产的站内 slug。
  slug: string;
  /// 被依赖资产的展示名。
  displayName: string;
  /// 被依赖资产的类型。
  kind: AssetKind;
  /// 版本约束（只展示，不求解）。
  constraint: string | null;
};

/**
 * 把依赖声明解析成站内资产。
 *
 * 一次性把声明里的 slug 全查出来（`IN` 查询），不做 N+1。
 *
 * @param declarations 清单里解析出来的依赖声明。
 * @param options.selfSlug 依赖方自己的 slug（用来挡住「自己依赖自己」）。
 * @throws {DependencyResolveError} 目标不存在 / 自己依赖自己 / 类型对不上。
 */
export async function resolveDependencyTargets(
  declarations: DependencyDeclaration[],
  options: { selfSlug?: string | null } = {},
): Promise<ResolvedDependency[]> {
  if (declarations.length === 0) {
    return [];
  }

  const slugs = declarations.map((entry) => entry.slug);
  const assets = await prisma.asset.findMany({
    where: { slug: { in: slugs } },
    select: { id: true, slug: true, displayName: true, kind: true },
  });
  const bySlug = new Map(assets.map((asset) => [asset.slug, asset]));

  const resolved: ResolvedDependency[] = [];

  for (const declaration of declarations) {
    if (options.selfSlug && declaration.slug === options.selfSlug) {
      throw new DependencyResolveError(
        "SELF_DEPENDENCY",
        declaration.slug,
        `依赖目标「${declaration.slug}」就是它自己：资产不能依赖自己。`,
      );
    }

    const asset = bySlug.get(declaration.slug);
    if (!asset) {
      throw new DependencyResolveError(
        "UNKNOWN_TARGET",
        declaration.slug,
        `依赖目标「${declaration.slug}」在平台上不存在：先把它发布上来，再声明这依赖。`,
      );
    }

    if (declaration.kind && declaration.kind !== asset.kind) {
      throw new DependencyResolveError(
        "KIND_MISMATCH",
        declaration.slug,
        `依赖目标「${declaration.slug}」的类型对不上：清单里写的是 ${declaration.kind}，平台上它是 ${asset.kind}。`,
      );
    }

    resolved.push({
      assetId: asset.id,
      slug: asset.slug,
      displayName: asset.displayName,
      kind: asset.kind,
      constraint: declaration.version ?? null,
    });
  }

  return resolved;
}

/** 详情页展示用的依赖节点。 */
export type DependencyNodeView = {
  /// 站内 slug（详情页链接用它）。
  slug: string;
  /// 展示名。
  displayName: string;
  /// 资产类型。
  kind: AssetKind;
  /// 版本约束（只展示，不求解）。
  constraint: string | null;
};

/** 一个资产的依赖关系（出边 + 入边）。 */
export type AssetDependenciesView = {
  /// 依赖了谁（出边）。
  dependsOn: DependencyNodeView[];
  /// 被谁依赖（入边）。
  dependedOnBy: DependencyNodeView[];
};

/**
 * 取一个资产的依赖关系。
 *
 * ⚠️ 已归档的依赖目标**不展示**（但关系还在库里）：归档条目前端不可见，
 *    详情页不该给出点进去 404 的链接。
 */
export async function listAssetDependencies(assetId: string): Promise<AssetDependenciesView> {
  const [outgoing, incoming] = await Promise.all([
    prisma.assetDependency.findMany({
      where: { fromId: assetId },
      select: {
        constraint: true,
        to: { select: { slug: true, displayName: true, kind: true, archivedAt: true } },
      },
    }),
    prisma.assetDependency.findMany({
      where: { toId: assetId },
      select: {
        constraint: true,
        from: { select: { slug: true, displayName: true, kind: true, archivedAt: true } },
      },
    }),
  ]);

  return {
    dependsOn: outgoing
      .filter((row) => row.to.archivedAt === null)
      .map((row) => ({
        slug: row.to.slug,
        displayName: row.to.displayName,
        kind: row.to.kind,
        constraint: row.constraint,
      })),
    dependedOnBy: incoming
      .filter((row) => row.from.archivedAt === null)
      .map((row) => ({
        slug: row.from.slug,
        displayName: row.from.displayName,
        kind: row.from.kind,
        constraint: row.constraint,
      })),
  };
}
