/**
 * 详情页展示依赖关系（票 #17）—— 页面渲染 + 详情接口。
 *
 * 验的是**外部可观察行为**（真实 Postgres + 真实页面组件）：
 *   - 详情页展示「依赖了谁」（出边）与「被谁依赖」（入边）；
 *   - 详情接口返回同一份依赖关系（页面与接口读同一份视图模型）；
 *   - 没有依赖关系时说清楚，而不是留一块空白；
 *   - 已归档的依赖目标不展示（不给点进去 404 的死链）。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GET as getSkill } from "@/app/api/skills/[slug]/route";
import McpDetailPage from "@/app/mcp/[slug]/page";
import SkillDetailPage from "@/app/skills/[slug]/page";
import { replaceAssetDependencies, writeAsset } from "@/lib/asset-writer";
import { prisma } from "@/lib/prisma";

/** 被依赖方。 */
const TARGET_SLUG = "pdf-batch-processor";
/** 依赖方。 */
const DEPENDENT_SLUG = "pdf-report-skill";

/** 三个角色：被依赖方、依赖方、另一个也依赖被依赖方的资产。 */
async function seedGraph(): Promise<void> {
  const target = await writeAsset({
    kind: "SKILL",
    slug: TARGET_SLUG,
    displayName: "批量处理 PDF 工具",
    license: "MIT",
    summaryZh: "批量处理 PDF 与文档转换的技能。",
    summarySource: "TEMPLATE",
  });

  const dependent = await writeAsset({
    kind: "SKILL",
    slug: DEPENDENT_SLUG,
    displayName: "报表生成器",
    license: "MIT",
    summaryZh: "把数据做成报表。",
    summarySource: "TEMPLATE",
  });

  const another = await writeAsset({
    kind: "SKILL",
    slug: "another-dependent",
    displayName: "另一个依赖方",
    license: "MIT",
    summaryZh: "也依赖 PDF 工具。",
    summarySource: "TEMPLATE",
  });

  await replaceAssetDependencies(dependent.id, [
    { toId: target.id, kind: "SKILL", constraint: ">=1.2.0" },
  ]);
  await replaceAssetDependencies(another.id, [{ toId: target.id, kind: "SKILL" }]);
}

describe("详情页 —— 依赖关系", () => {
  it("Skill 详情页展示「依赖了谁」与「被谁依赖」", async () => {
    await seedGraph();

    const html = renderToStaticMarkup(
      await SkillDetailPage({ params: Promise.resolve({ slug: DEPENDENT_SLUG }) }),
    );

    expect(html).toContain("依赖关系");
    expect(html).toContain("依赖了谁");
    expect(html).toContain("被谁依赖");
    // 出边：依赖目标的名字、链接与版本约束。
    expect(html).toContain("批量处理 PDF 工具");
    expect(html).toContain(`href="/skills/${TARGET_SLUG}"`);
    expect(html).toContain("&gt;=1.2.0");
  });

  it("被依赖方那一侧能看到反向关系（谁依赖了它）", async () => {
    await seedGraph();

    const html = renderToStaticMarkup(
      await SkillDetailPage({ params: Promise.resolve({ slug: TARGET_SLUG }) }),
    );

    expect(html).toContain("被谁依赖");
    expect(html).toContain("报表生成器");
    expect(html).toContain("另一个依赖方");
    expect(html).toContain(`href="/skills/${DEPENDENT_SLUG}"`);
  });

  it("MCP 详情页同样展示依赖关系", async () => {
    await seedGraph();

    const mcp = await writeAsset({
      kind: "MCP",
      slug: "pdf-mcp-server",
      displayName: "PDF 文档 MCP 服务",
      license: null,
      summaryZh: "通过 MCP 读取 PDF 文档。",
      summarySource: "TEMPLATE",
    });
    const target = await prisma.asset.findUniqueOrThrow({ where: { slug: TARGET_SLUG } });
    await replaceAssetDependencies(mcp.id, [{ toId: target.id, kind: "SKILL" }]);

    const html = renderToStaticMarkup(
      await McpDetailPage({ params: Promise.resolve({ slug: "pdf-mcp-server" }) }),
    );

    expect(html).toContain("依赖关系");
    expect(html).toContain("批量处理 PDF 工具");
    expect(html).toContain("被谁依赖");
  });

  it("详情接口返回同一份依赖关系（页面与接口同源）", async () => {
    await seedGraph();

    const response = await getSkill(new Request("http://localhost/api/skills/x"), {
      params: Promise.resolve({ slug: DEPENDENT_SLUG }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.dependencies.dependsOn).toEqual([
      {
        slug: TARGET_SLUG,
        displayName: "批量处理 PDF 工具",
        kind: "SKILL",
        constraint: ">=1.2.0",
      },
    ]);
    expect(body.dependencies.dependedOnBy).toEqual([]);
  });

  it("没有依赖关系时说清楚，而不是留一块空白", async () => {
    await writeAsset({
      kind: "SKILL",
      slug: "lonely-skill",
      displayName: "独行侠",
      license: "MIT",
      summaryZh: "谁也不依赖。",
      summarySource: "TEMPLATE",
    });

    const html = renderToStaticMarkup(
      await SkillDetailPage({ params: Promise.resolve({ slug: "lonely-skill" }) }),
    );

    expect(html).toContain("依赖关系");
    expect(html).toContain("没有声明依赖");
    expect(html).toContain("还没有别的资产声明依赖它");
  });

  it("已归档的依赖目标不展示（不给点进去 404 的死链）", async () => {
    await seedGraph();

    await prisma.asset.update({
      where: { slug: TARGET_SLUG },
      data: { archivedAt: new Date("2026-01-01T00:00:00.000Z") },
    });

    const html = renderToStaticMarkup(
      await SkillDetailPage({ params: Promise.resolve({ slug: DEPENDENT_SLUG }) }),
    );

    expect(html).toContain("依赖关系");
    expect(html).not.toContain(`href="/skills/${TARGET_SLUG}"`);
    // 关系还在库里（只是不展示）。
    expect(await prisma.assetDependency.count()).toBe(2);
  });
});
