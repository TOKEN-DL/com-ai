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
import SkillDetailPage from "@/app/skills/[slug]/page";
import { writeAsset } from "@/lib/asset-writer";
import { prisma } from "@/lib/prisma";
import { deriveScenarioCards } from "@/lib/scenario-service";
import { createSession, SESSION_COOKIE } from "@/lib/session";

const SKILL_SLUG = "pdf-batch-processor";
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
