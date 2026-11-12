/**
 * 详情页的「依赖关系」区块（票 #17）。
 *
 * ## 呈现形态为什么是「两栏列表」而不是一张图
 *
 * 依赖关系是**有向的二分关系**：一个资产依赖若干资产，被若干资产依赖。
 * 两栏列表（出边 / 入边）已经把关系说全了，而且：
 *   - 不需要图表库（不许新增运行时依赖）；
 *   - 服务端渲染，没有客户端 JS；
 *   - 文字可读、可复制、可被无障碍工具读出来。
 *
 * 箭头（→ / ←）标出方向：→ 是「我依赖它」，← 是「它依赖我」。
 */
import type { AssetKind } from "@prisma/client";
import Link from "next/link";

import { assetDetailHref } from "@/lib/asset-item";
import type { DependencyNodeView } from "@/lib/dependency-service";

/** 分类（资产类型）的展示名。 */
const KIND_LABELS: Record<AssetKind, string> = {
  SKILL: "Skill",
  MCP: "MCP",
  PROMPT: "Prompt",
};

/** 一条依赖关系（出边 / 入边共用）。 */
function DependencyItem({ node, direction }: { node: DependencyNodeView; direction: "out" | "in" }) {
  return (
    <li>
      <span aria-hidden="true" className="dependency-arrow">
        {direction === "out" ? "→" : "←"}
      </span>
      <Link href={assetDetailHref(node.kind, node.slug)}>{node.displayName}</Link>
      <span className="badge-muted">{KIND_LABELS[node.kind]}</span>
      {/* 版本约束只展示、不求解（spec 决策 1：不做依赖自动求解器）。 */}
      {node.constraint ? <span className="badge-muted">{node.constraint}</span> : null}
    </li>
  );
}

/**
 * 依赖关系区块。
 *
 * @param slug 当前资产的 slug（用于「在检索里查看」的链接）。
 * @param dependsOn 出边：这个资产依赖了谁。
 * @param dependedOnBy 入边：谁依赖了这个资产。
 */
export function DependencySection({
  slug,
  dependsOn,
  dependedOnBy,
}: {
  slug: string;
  dependsOn: DependencyNodeView[];
  dependedOnBy: DependencyNodeView[];
}) {
  return (
    <section className="meta" id="dependencies">
      <h2>依赖关系</h2>

      <div className="dependency-grid">
        <div className="dependency-side">
          <h3>依赖了谁</h3>
          {dependsOn.length === 0 ? (
            <p className="badge-muted">这个资产没有声明依赖。</p>
          ) : (
            <ul className="dependency-list">
              {dependsOn.map((node) => (
                <DependencyItem key={`out:${node.slug}`} node={node} direction="out" />
              ))}
            </ul>
          )}
        </div>

        <div className="dependency-side">
          <h3>被谁依赖</h3>
          {dependedOnBy.length === 0 ? (
            <p className="badge-muted">暂时还没有别的资产声明依赖它。</p>
          ) : (
            <ul className="dependency-list">
              {dependedOnBy.map((node) => (
                <DependencyItem key={`in:${node.slug}`} node={node} direction="in" />
              ))}
            </ul>
          )}
          {/* 依赖关系是可检索的：这里给一个直达检索的入口。 */}
          <p className="note">
            依赖关系可以被检索：
            <Link href={`/search?dependsOn=${encodeURIComponent(slug)}`}>
              在检索里看依赖了它的资产
            </Link>
          </p>
        </div>
      </div>
    </section>
  );
}
