/**
 * Skill 列表页（票 #24 切片 3）。
 *
 * 这一页改走 `SearchService` 之前是 `listAssets({ limit: 50 })`：
 * 没有筛选、没有排序、没有分页，页头的「收录 N 个」显示的其实是当前页的 50 条 ——
 * 数字看起来像总数，其实不是。
 *
 * 这里钉住三件事：**总数是真的**、**排序真的生效**、**分页真的能翻**。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import SkillListPage from "@/app/skills/page";
import { writeAsset } from "@/lib/asset-writer";

/**
 * 每个 Skill 的独有标记词。
 *
 * 不能用「列表技能 1」这种查询来测「只命中一条」——
 * pg_trgm 的 `word_similarity` 会拿公共词「列表技能」比过去，
 * 三条全部命中（实测）。要测精确命中，得用互相不像的标记词。
 */
const MARKERS = ["zzalpha", "zzbeta", "zzgamma"];

/**
 * 建一批 Skill。
 *
 * 热度与安装量**故意反着排**（热度第 0 的安装量最大）——
 * 这样「换了排序口径顺序确实变了」才测得到，而不是碰巧没变。
 */
async function seedSkills(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await writeAsset({
      kind: "SKILL",
      slug: `skill-list-${index}`,
      displayName: `列表技能 ${index}`,
      license: "MIT",
      contentBody: `列表技能 ${index} 的正文，标记 ${MARKERS[index]}。`,
      summaryZh: `列表技能 ${index} 的简介。`,
      summarySource: "TEMPLATE",
      heatScore: count - index,
      installs: index * 100,
      trendScore: index / 100,
      stars: index,
    });
  }
}

/** 渲染列表页。 */
async function renderSkills(params: Record<string, string> = {}): Promise<string> {
  const element = await SkillListPage({ searchParams: Promise.resolve(params) });
  return renderToStaticMarkup(element);
}

describe("Skill 列表页 —— 收录数是真实总数", () => {
  it("页头显示的是命中总数，不是当前页条数", async () => {
    await seedSkills(3);

    const html = await renderSkills({ pageSize: "2" });

    // 总数 3，当前页只有 2 条。
    expect(html).toContain("共 3 个");
  });

  it("关键词过滤后的总数也是真的", async () => {
    await seedSkills(3);

    const html = await renderSkills({ q: "zzbeta" });

    expect(html).toContain("共 1 个");
  });
});

describe("Skill 列表页 —— 排序", () => {
  it("默认按热度排序", async () => {
    await seedSkills(3);

    const html = await renderSkills();

    // 热度与安装量反着排：热度第一的是「列表技能 0」。
    expect(html.indexOf("列表技能 0")).toBeLessThan(html.indexOf("列表技能 2"));
  });

  it("按安装量排序时顺序换过来了", async () => {
    await seedSkills(3);

    const html = await renderSkills({ sort: "installs" });

    // 安装量第一的是「列表技能 2」。
    expect(html.indexOf("列表技能 2")).toBeLessThan(html.indexOf("列表技能 0"));
  });

  it("按近期增速排序时把增速显示出来（否则列表顺序看着像随机的）", async () => {
    await seedSkills(3);

    const html = await renderSkills({ sort: "trending" });

    expect(html).toContain("近期增速");
    expect(html).toContain("+2%");
  });

  it("排序下拉里有安装量与近期增速两个口径", async () => {
    await seedSkills(1);

    const html = await renderSkills();

    expect(html).toContain("安装量");
    expect(html).toContain("近期增速");
  });
});

describe("Skill 列表页 —— 筛选与分页", () => {
  it("有搜索框与排序下拉", async () => {
    await seedSkills(1);

    const html = await renderSkills();

    expect(html).toContain('action="/skills"');
    expect(html).toContain('name="q"');
    expect(html).toContain('name="sort"');
  });

  it("结果超过一页时给出翻页链接", async () => {
    await seedSkills(3);

    const html = await renderSkills({ pageSize: "2" });

    expect(html).toContain("第 1 / 2 页");
    expect(html).toContain("下一页");
  });

  it("关键词搜不到时给出提示，而不是「还没有收录任何 Skill」", async () => {
    await seedSkills(1);

    const html = await renderSkills({ q: "根本不存在的关键词" });

    expect(html).toContain("没有匹配的条目");
    expect(html).not.toContain("还没有收录任何 Skill");
  });
});
