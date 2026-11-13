/**
 * 首页榜单（票 #24 切片 4）。
 *
 * spec 故事 13「作为访问者，我想看到全站最受欢迎的技能榜单」与
 * 故事 14「我想看到近期增长最快的技能」—— 此前首页只有一个「环境状态」表，
 * 两个榜单都没有。
 *
 * 这里钉住：榜单**存在**、**只排 Skill**、**顺序真的按口径排**、
 * 没有数据时**不装样子**。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import HomePage from "@/app/page";
import { writeAsset } from "@/lib/asset-writer";

/**
 * 一组安装量与增速**故意互相打架**的资产：
 * 装得最多的不是涨得最快的，涨得最快的也不是装得最多的。
 */
async function seedBoardAssets(): Promise<void> {
  await writeAsset({
    kind: "SKILL",
    slug: "board-installs-top",
    displayName: "安装量冠军",
    license: "MIT",
    contentBody: "安装量最多的技能。",
    summaryZh: "装得最多。",
    summarySource: "TEMPLATE",
    heatScore: 1,
    installs: 5000,
    trendScore: -0.4,
  });

  await writeAsset({
    kind: "SKILL",
    slug: "board-trend-top",
    displayName: "增速冠军",
    license: "MIT",
    contentBody: "涨得最快的技能。",
    summaryZh: "涨得最快。",
    summarySource: "TEMPLATE",
    heatScore: 2,
    installs: 10,
    trendScore: 0.8,
  });

  // MCP 没有安装量口径，不该出现在任何一张榜上 —— 哪怕它热度拉满。
  await writeAsset({
    kind: "MCP",
    slug: "board-mcp",
    displayName: "不该上榜的 MCP",
    license: null,
    contentBody: "一个 MCP 服务。",
    summaryZh: "一个 MCP 服务。",
    summarySource: "TEMPLATE",
    heatScore: 99,
    installs: 9999,
  });
}

/** 取出某个榜单那一段 HTML（按 `<h2>` 标题定位到 `</section>`）。 */
function boardSection(html: string, title: string): string {
  const start = html.indexOf(`<h2>${title}</h2>`);
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf("</section>", start);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

describe("首页榜单 —— 存在且只排 Skill", () => {
  it("两张榜都在", async () => {
    await seedBoardAssets();

    const html = renderToStaticMarkup(await HomePage());

    expect(html).toContain("全站最受欢迎的 Skill");
    expect(html).toContain("近期增长最快的 Skill");
  });

  it("MCP 不进榜（spec 决策 5 的三个热度视图是 Skill 管道的定义）", async () => {
    await seedBoardAssets();

    const html = renderToStaticMarkup(await HomePage());

    expect(html).not.toContain("不该上榜的 MCP");
  });

  it("两张榜都给出完整榜单的入口", async () => {
    await seedBoardAssets();

    const html = renderToStaticMarkup(await HomePage());

    expect(html).toContain('href="/skills?sort=installs"');
    expect(html).toContain('href="/skills?sort=trending"');
  });
});

describe("首页榜单 —— 顺序真的按口径排", () => {
  it("最受欢迎榜按累计安装量排", async () => {
    await seedBoardAssets();

    const html = renderToStaticMarkup(await HomePage());
    const section = boardSection(html, "全站最受欢迎的 Skill");

    expect(section.indexOf("安装量冠军")).toBeGreaterThan(-1);
    expect(section.indexOf("安装量冠军")).toBeLessThan(section.indexOf("增速冠军"));
  });

  it("增速榜按近期增速排（跟安装量榜不是同一个顺序）", async () => {
    await seedBoardAssets();

    const html = renderToStaticMarkup(await HomePage());
    const section = boardSection(html, "近期增长最快的 Skill");

    expect(section.indexOf("增速冠军")).toBeGreaterThan(-1);
    expect(section.indexOf("增速冠军")).toBeLessThan(section.indexOf("安装量冠军"));
  });

  it("增速榜把增速显示出来", async () => {
    await seedBoardAssets();

    const html = renderToStaticMarkup(await HomePage());
    const section = boardSection(html, "近期增长最快的 Skill");

    expect(section).toContain("近期增速");
    expect(section).toContain("+80%");
  });
});

describe("首页榜单 —— 没有数据时不装样子", () => {
  it("一个增速数据都没有时，增速榜给提示而不是按热度凑一个榜", async () => {
    await writeAsset({
      kind: "SKILL",
      slug: "board-no-trend",
      displayName: "没有趋势数据的技能",
      license: "MIT",
      contentBody: "正文。",
      summaryZh: "简介。",
      summarySource: "TEMPLATE",
      heatScore: 5,
      installs: 100,
    });

    const html = renderToStaticMarkup(await HomePage());
    const section = boardSection(html, "近期增长最快的 Skill");

    expect(section).toContain("增速数据还没有采到");
    expect(section).not.toContain("没有趋势数据的技能");
  });

  it("一条 Skill 都没收录时，两张榜都给提示", async () => {
    const html = renderToStaticMarkup(await HomePage());

    expect(html).toContain("还没有收录任何 Skill");
  });
});
