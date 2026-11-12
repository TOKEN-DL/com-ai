/**
 * 场景卡片的 HTTP 边界（票 #12 验收标准第 1~4 条）。
 *
 * Seam 2 —— HTTP 边界：页面渲染、检索接口、评论接口都对着**真实测试 Postgres** 跑
 * （全文检索与 trigram 的行为必须在真实 Postgres 上验证，不用内存替身）。
 *
 * 盯四件事：
 *   1. 场景卡片落库成独立的资产行，并记着它是从哪个 Skill 派生的；
 *   2. 列表页与详情页展示场景描述，并**直达对应 Skill 详情**；
 *   3. 卡片**能被统一搜索命中**（按 kind = SCENARIO 过滤也命中）；
 *   4. 卡片下方**可评论**，且评论与资产详情页是**同一套数据**。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { POST as postComment } from "@/app/api/assets/[slug]/comments/route";
import { GET as searchApi } from "@/app/api/search/route";
import ScenarioDetailPage from "@/app/scenarios/[slug]/page";
import ScenarioListPage from "@/app/scenarios/page";
import SearchPage from "@/app/search/page";
import SkillDetailPage from "@/app/skills/[slug]/page";
import { writeAsset } from "@/lib/asset-writer";
import { prisma } from "@/lib/prisma";
import { deriveScenarioCards } from "@/lib/scenario-service";
import { createSession, SESSION_COOKIE } from "@/lib/session";

const SKILL_SLUG = "pdf-batch-processor";
const FRONTMATTER_ONLY_SLUG = "frontmatter-only-skill";
const WHEN_TO_USE = "当需要批量处理 PDF 文件时使用。";

/** 造一个 FULL 档的 Skill（带「何时用」与 frontmatter 自述）。 */
async function seedSkill(): Promise<void> {
  await writeAsset({
    kind: "SKILL",
    slug: SKILL_SLUG,
    displayName: "批量处理 PDF 工具",
    license: "MIT",
    contentBody: "批量处理 PDF 文件。",
    summaryZh: "批量处理 PDF 与文档转换的技能。",
    summarySource: "LLM",
    whenToUse: WHEN_TO_USE,
    howToUse: "装上之后在会话里调用即可。",
    heatScore: 7,
    repoOwner: "example",
    repoName: "pdf-tools",
    repoUrl: "https://github.com/example/pdf-tools",
    detail: {
      skill: {
        frontmatter: {
          name: SKILL_SLUG,
          description: "Batch process PDF files into a single archive.",
        },
      },
    },
  });
}

/** 造一个只有 frontmatter 自述、没有「何时用」的 Skill（场景来自上游作者自述）。 */
async function seedFrontmatterOnlySkill(): Promise<void> {
  await writeAsset({
    kind: "SKILL",
    slug: FRONTMATTER_ONLY_SLUG,
    displayName: "只有自述的技能",
    license: "MIT",
    contentBody: "上游正文。",
    summaryZh: "上游自述摘要。",
    summarySource: "LLM",
    whenToUse: null,
    howToUse: null,
    heatScore: 3,
    repoOwner: "example",
    repoName: "subtitle-tools",
    repoUrl: "https://github.com/example/subtitle-tools",
    detail: {
      skill: {
        frontmatter: {
          name: FRONTMATTER_ONLY_SLUG,
          description: "Use this when you need to transcribe subtitles from a video file.",
        },
      },
    },
  });
}

/** 派生场景卡片，返回卡片自己的 slug。 */
async function derive(): Promise<string> {
  const asset = await prisma.asset.findUniqueOrThrow({ where: { slug: SKILL_SLUG } });
  const outcome = await deriveScenarioCards(asset.id);
  expect(outcome.derived).toBeGreaterThan(0);
  return outcome.cardSlugs[0];
}

/** 造一个带会话 cookie 的请求。 */
function authed(token: string, url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    },
    body: JSON.stringify(body),
  });
}

async function seedUser(): Promise<{ token: string }> {
  const user = await prisma.user.create({
    data: { email: "scenario@example.com", emailVerifiedAt: new Date(), displayName: "场景用户" },
  });
  const { token } = await createSession({ userId: user.id });
  return { token };
}

describe("场景卡片落库", () => {
  it("派生出的卡片是一条独立的资产行，并记着它是从哪个 Skill 派生的", async () => {
    await seedSkill();
    const cardSlug = await derive();

    const card = await prisma.asset.findUniqueOrThrow({ where: { slug: cardSlug } });
    expect(card.kind).toBe("SCENARIO");
    expect(card.displayName).toBe("需要批量处理 PDF 文件");
    expect(card.license).toBe("mit");

    const detail = await prisma.scenarioDetail.findUniqueOrThrow({ where: { assetId: card.id } });
    const source = await prisma.asset.findUniqueOrThrow({ where: { slug: SKILL_SLUG } });
    expect(detail.sourceAssetId).toBe(source.id);
    expect(detail.sourceAssetSlug).toBe(SKILL_SLUG);
    expect(detail.origin).toBe("whenToUse");
  });

  it("派生过程不产生重复卡片：重跑一遍还是那一张", async () => {
    await seedSkill();
    const cardSlug = await derive();

    const again = await derive();

    expect(again).toBe(cardSlug);
    expect(await prisma.asset.count({ where: { kind: "SCENARIO" } })).toBe(1);
    expect(await prisma.scenarioDetail.count()).toBe(1);
  });

  it("数据库层也不允许同一资产 + 同一场景出现两张卡片", async () => {
    await seedSkill();
    const cardSlug = await derive();
    const card = await prisma.asset.findUniqueOrThrow({ where: { slug: cardSlug } });
    const detail = await prisma.scenarioDetail.findUniqueOrThrow({ where: { assetId: card.id } });

    await expect(
      prisma.scenarioDetail.create({
        data: {
          assetId: "another-card",
          sourceAssetId: detail.sourceAssetId,
          sourceAssetSlug: detail.sourceAssetSlug,
          scenarioText: detail.scenarioText,
          scenarioKey: detail.scenarioKey,
          origin: detail.origin,
        },
      }),
    ).rejects.toThrow();
  });
});

describe("场景卡片的页面", () => {
  it("列表页展示场景卡片，并给出直达 Skill 的链接", async () => {
    await seedSkill();
    const cardSlug = await derive();

    const html = renderToStaticMarkup(
      await ScenarioListPage({ searchParams: Promise.resolve({}) }),
    );

    expect(html).toContain(`href="/scenarios/${cardSlug}"`);
    expect(html).toContain("需要批量处理 PDF 文件");
    // 直达 Skill：列表页就该给出这个链接，不必先进详情页。
    expect(html).toContain(`href="/skills/${SKILL_SLUG}"`);
  });

  it("详情页展示场景描述，并直达对应 Skill 详情", async () => {
    await seedSkill();
    const cardSlug = await derive();

    const html = renderToStaticMarkup(
      await ScenarioDetailPage({ params: Promise.resolve({ slug: cardSlug }) }),
    );

    expect(html).toContain("需要批量处理 PDF 文件");
    expect(html).toContain(WHEN_TO_USE);
    expect(html).toContain(`href="/skills/${SKILL_SLUG}"`);
    expect(html).toContain("批量处理 PDF 工具");
  });
});

describe("场景卡片的简介来源标注", () => {
  it("卡片抄的是 LLM 生成的「何时用」时，来源标记必须是 LLM，不能当成模板生成", async () => {
    await seedSkill();
    const cardSlug = await derive();

    const card = await prisma.asset.findUniqueOrThrow({ where: { slug: cardSlug } });
    // spec 约束 2：LLM 生成的简介必须标注「AI 生成，版权归原作者」。
    // 标成 TEMPLATE 就是漏标 —— 那段文字确实是模型写的。
    expect(card.summarySource).toBe("LLM");
  });

  it("卡片页把「AI 生成，版权归原作者」标出来，并给出原仓库链接与许可证", async () => {
    await seedSkill();
    const cardSlug = await derive();

    const html = renderToStaticMarkup(
      await ScenarioDetailPage({ params: Promise.resolve({ slug: cardSlug }) }),
    );

    expect(html).toContain("AI 生成，版权归原作者");
    // 标注之外，还要能一键回到原文出处（仓库链接 + 许可证标识）。
    expect(html).toContain("原文与版权归属");
    expect(html).toContain("https://github.com/example/pdf-tools");
    expect(html).toContain("mit");
  });

  it("卡片抄的是上游作者自述时，标成「人工撰写」，不冒认成 AI 生成", async () => {
    await seedFrontmatterOnlySkill();
    const asset = await prisma.asset.findUniqueOrThrow({
      where: { slug: FRONTMATTER_ONLY_SLUG },
    });
    const outcome = await deriveScenarioCards(asset.id);
    expect(outcome.derived).toBeGreaterThan(0);

    const card = await prisma.asset.findUniqueOrThrow({ where: { slug: outcome.cardSlugs[0] } });
    expect(card.summarySource).toBe("HUMAN");

    const html = renderToStaticMarkup(
      await ScenarioDetailPage({ params: Promise.resolve({ slug: outcome.cardSlugs[0] }) }),
    );
    expect(html).toContain("人工撰写");
    expect(html).not.toContain("AI 生成，版权归原作者");
  });
});

describe("场景卡片能被统一搜索命中", () => {
  it("按关键词能搜到这张卡片", async () => {
    await seedSkill();
    const cardSlug = await derive();

    const response = await searchApi(new Request("http://localhost/api/search?q=PDF"));
    const body = (await response.json()) as {
      items: { slug: string; kind: string }[];
    };

    expect(body.items.map((item) => item.slug)).toContain(cardSlug);
    expect(body.items.find((item) => item.slug === cardSlug)?.kind).toBe("SCENARIO");
  });

  it("按分类（kind = SCENARIO）过滤也命中", async () => {
    await seedSkill();
    const cardSlug = await derive();

    const response = await searchApi(
      new Request("http://localhost/api/search?kind=SCENARIO&sort=heat"),
    );
    const body = (await response.json()) as {
      items: { slug: string }[];
      facets: { kind: { value: string; count: number }[] };
    };

    expect(body.items.map((item) => item.slug)).toContain(cardSlug);
    expect(body.facets.kind).toEqual(
      expect.arrayContaining([{ value: "SCENARIO", count: 1 }]),
    );
  });

  it("搜索页里的场景卡片指向自己的详情页", async () => {
    await seedSkill();
    const cardSlug = await derive();

    const html = renderToStaticMarkup(
      await SearchPage({ searchParams: Promise.resolve({ kind: "SCENARIO" }) }),
    );

    // 场景卡片有**自己的**详情页，不能落到 /skills/{卡片 slug}（那是 404）。
    expect(html).toContain(`href="/scenarios/${cardSlug}"`);
  });
});

describe("场景卡片下方的评论", () => {
  it("在卡片下发表的评论落在源 Skill 上，资产详情页与卡片页看到的是同一批评论", async () => {
    await seedSkill();
    const cardSlug = await derive();
    const user = await seedUser();

    const response = await postComment(
      authed(user.token, `http://localhost/api/assets/${cardSlug}/comments`, {
        body: "这个场景的参数要这样调",
      }),
      { params: Promise.resolve({ slug: cardSlug }) },
    );
    expect(response.status).toBe(201);

    // 同一套评论数据：评论挂在**源 Skill** 上，不是卡片自己。
    const source = await prisma.asset.findUniqueOrThrow({ where: { slug: SKILL_SLUG } });
    const comments = await prisma.comment.findMany();
    expect(comments).toHaveLength(1);
    expect(comments[0].assetId).toBe(source.id);

    const skillHtml = renderToStaticMarkup(
      await SkillDetailPage({ params: Promise.resolve({ slug: SKILL_SLUG }) }),
    );
    const cardHtml = renderToStaticMarkup(
      await ScenarioDetailPage({ params: Promise.resolve({ slug: cardSlug }) }),
    );

    expect(skillHtml).toContain("这个场景的参数要这样调");
    expect(cardHtml).toContain("这个场景的参数要这样调");
  });

  it("在 Skill 详情页发表的评论，同样出现在场景卡片下方", async () => {
    await seedSkill();
    const cardSlug = await derive();
    const user = await seedUser();

    const response = await postComment(
      authed(user.token, `http://localhost/api/assets/${SKILL_SLUG}/comments`, {
        body: "补充一条经验",
      }),
      { params: Promise.resolve({ slug: SKILL_SLUG }) },
    );
    expect(response.status).toBe(201);

    const cardHtml = renderToStaticMarkup(
      await ScenarioDetailPage({ params: Promise.resolve({ slug: cardSlug }) }),
    );
    expect(cardHtml).toContain("补充一条经验");
  });
});

describe("场景卡片的检索入口约束", () => {
  const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const entryFiles = ["src/app/scenarios/page.tsx", "src/app/scenarios/[slug]/page.tsx"];

  it("页面不直接查数据库（不 import Prisma 客户端，也不写原生 SQL）", () => {
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

  it("列表页的检索经由 SearchService", () => {
    const source = readFileSync(path.join(REPO_ROOT, "src/app/scenarios/page.tsx"), "utf8");

    expect(source).toMatch(/getSearchService/);
    expect(source).toMatch(/kind: \["SCENARIO"\]/);
  });
});
