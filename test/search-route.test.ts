/**
 * 检索的 HTTP 边界与入口约束（票 #5）。
 *
 * 三件事：
 *   1. `/api/search` 真的按关键词返回条目、总数与分面；
 *   2. `/search` 页面渲染出的结果项指向详情页 `/skills/{slug}`；
 *   3. **检索全部经由 SearchService** —— 页面与接口里没有任何直接查库的路径。
 *
 * 第 3 条是硬要求，所以用静态检查钉死：页面与接口一旦开始直接 import
 * Prisma 客户端或写原生 SQL，这个测试就会红。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GET as searchApi } from "@/app/api/search/route";
import SearchPage from "@/app/search/page";
import { writeAsset } from "@/lib/asset-writer";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function seedAssets(): Promise<void> {
  await writeAsset({
    kind: "SKILL",
    slug: "pdf-batch-processor",
    displayName: "批量处理 PDF 工具",
    license: "MIT",
    contentBody: "批量处理 PDF 文件。",
    summaryZh: "批量处理 PDF 与文档转换的技能。",
    summarySource: "TEMPLATE",
    heatScore: 7,
    isOfficial: true,
  });

  await writeAsset({
    kind: "MCP",
    slug: "pdf-mcp-server",
    displayName: "PDF 文档 MCP 服务",
    license: null,
    summaryZh: "通过 MCP 读取 PDF 文档。",
    summarySource: "TEMPLATE",
    heatScore: 5,
  });

  await writeAsset({
    kind: "SKILL",
    slug: "docker-compose-guide",
    displayName: "Docker Compose 部署指南",
    license: "Apache-2.0",
    contentBody: "用 Compose 编排整套服务。",
    summaryZh: "用 Compose 编排整套服务。",
    summarySource: "TEMPLATE",
    heatScore: 9,
  });
}

describe("GET /api/search", () => {
  it("按关键词返回条目、总数与分面", async () => {
    await seedAssets();

    const response = await searchApi(new Request("http://localhost/api/search?q=pdf"));

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.total).toBe(2);
    expect(body.items.map((item: { slug: string }) => item.slug).sort()).toEqual([
      "pdf-batch-processor",
      "pdf-mcp-server",
    ]);
    expect(body.items[0]).toMatchObject({
      displayName: expect.any(String),
      slug: expect.any(String),
    });
    expect(body.query.q).toBe("pdf");
    expect(body.facets.kind).toEqual(
      expect.arrayContaining([
        { value: "SKILL", count: 1 },
        { value: "MCP", count: 1 },
      ]),
    );
  });

  it("支持按分类、许可证、官方版本筛选与排序", async () => {
    await seedAssets();

    const response = await searchApi(
      new Request("http://localhost/api/search?kind=SKILL&license=mit&official=true&sort=heat"),
    );

    const body = await response.json();
    expect(body.total).toBe(1);
    expect(body.items[0].slug).toBe("pdf-batch-processor");
    expect(body.query.filters).toEqual({
      kind: ["SKILL"],
      license: ["mit"],
      official: true,
    });
  });

  it("「未声明许可证」用 __none__ 表示", async () => {
    await seedAssets();

    const response = await searchApi(
      new Request("http://localhost/api/search?license=__none__"),
    );

    const body = await response.json();
    expect(body.total).toBe(1);
    expect(body.items[0].slug).toBe("pdf-mcp-server");
  });

  it("分页参数生效", async () => {
    await seedAssets();

    const response = await searchApi(
      new Request("http://localhost/api/search?sort=heat&page=2&pageSize=2"),
    );

    const body = await response.json();
    expect(body.total).toBe(3);
    expect(body.page).toBe(2);
    expect(body.pageSize).toBe(2);
    expect(body.totalPages).toBe(2);
    expect(body.items).toHaveLength(1);
  });
});

describe("/search 页面", () => {
  it("结果项按 kind 指向各自的详情页", async () => {
    await seedAssets();

    const element = await SearchPage({
      searchParams: Promise.resolve({ q: "pdf" }),
    });
    const html = renderToStaticMarkup(element);

    // Skill 走 /skills/{slug}。
    expect(html).toContain('href="/skills/pdf-batch-processor"');
    // ⚠️ MCP 有自己的详情页（票 #13 补齐的路由）：链接必须跟着走，
    //    否则非 Skill 的结果项点进去就是 404。
    expect(html).toContain('href="/mcp/pdf-mcp-server"');
    expect(html).toContain("批量处理 PDF 工具");
  });

  it("渲染出筛选与排序控件", async () => {
    await seedAssets();

    const element = await SearchPage({
      searchParams: Promise.resolve({ q: "pdf" }),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain('name="q"');
    expect(html).toContain('name="sort"');
    expect(html).toContain("分类");
    expect(html).toContain("许可证");
    expect(html).toContain("官方版本");
  });
});

describe("检索入口约束", () => {
  const entryFiles = ["src/app/search/page.tsx", "src/app/api/search/route.ts"];

  it("页面与接口都不直接查数据库，检索一律经由 SearchService", () => {
    const offenders: string[] = [];

    for (const file of entryFiles) {
      const source = readFileSync(path.join(REPO_ROOT, file), "utf8");

      if (/from\s+"@\/lib\/prisma"/.test(source)) {
        offenders.push(`${file}：直接 import 了 Prisma 客户端`);
      }
      if (/\$queryRaw|\$executeRaw|\$queryRawUnsafe/.test(source)) {
        offenders.push(`${file}：写了原生 SQL`);
      }
      if (!/getSearchService/.test(source)) {
        offenders.push(`${file}：没有经由 SearchService`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("检索入口没有在资产列表查询里另写一套", () => {
    const source = readFileSync(path.join(REPO_ROOT, "src/lib/asset-query.ts"), "utf8");

    expect(source).not.toMatch(/export\s+(async\s+)?function\s+\w*[Ss]earch/);
    expect(source).not.toMatch(/from\s+"@\/lib\/search-postgres"/);
    expect(source).not.toMatch(/from\s+"@\/lib\/search-service"/);
  });

  it("MCP 与 Prompt 的页面、接口都不直接查数据库", () => {
    // 票 #13 的 MCP 页面与票 #15 的 Prompt 页面同样受同一条规矩约束：
    // 列表页走 SearchService，详情页走视图模型（@/lib/mcp-detail / @/lib/prompt-detail）。
    const entryFiles = [
      "src/app/mcp/page.tsx",
      "src/app/mcp/[slug]/page.tsx",
      "src/app/api/mcp/[slug]/route.ts",
      "src/app/prompts/page.tsx",
      "src/app/prompts/[slug]/page.tsx",
      "src/app/api/prompts/[slug]/route.ts",
    ];
    const offenders: string[] = [];

    for (const file of entryFiles) {
      const source = readFileSync(path.join(REPO_ROOT, file), "utf8");

      if (/from\s+"@\/lib\/prisma"/.test(source)) {
        offenders.push(`${file}：直接 import 了 Prisma 客户端`);
      }
      if (/\$queryRaw|\$executeRaw|\$queryRawUnsafe/.test(source)) {
        offenders.push(`${file}：写了原生 SQL`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("MCP 与 Prompt 的列表页的检索都经由 SearchService", () => {
    for (const file of ["src/app/mcp/page.tsx", "src/app/prompts/page.tsx"]) {
      const source = readFileSync(path.join(REPO_ROOT, file), "utf8");
      expect(source).toMatch(/getSearchService/);
    }
  });
});
