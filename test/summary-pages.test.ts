/**
 * 中文简介的 HTTP 边界（票 #7 验收标准）。
 *
 * 验的是**外部可观察行为**（Next.js 页面 / 路由 + 真实 Postgres）：
 *   - 详情页、列表页、搜索结果项都能看到中文简介，且「何时用」与「怎么用」**分区可见**；
 *   - 简介页上有「AI 生成，版权归原作者」的标注与原仓库链接；
 *   - 人工覆盖后，来源显示为**人工**；
 *   - 人工覆盖后，批量重跑**不覆盖**它；
 *   - 模型抛错时资产仍能入库，简介降级显示且来源标记正确。
 *
 * 简介生成器按 spec 的 port 约定注入确定性假实现（计数断言靠它）。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { PATCH as overrideRoute } from "@/app/api/assets/[slug]/summary/route";
import PromptDetailPage from "@/app/prompts/[slug]/page";
import PromptListPage from "@/app/prompts/page";
import SearchPage from "@/app/search/page";
import SkillDetailPage from "@/app/skills/[slug]/page";
import SkillListPage from "@/app/skills/page";
import { writeAsset } from "@/lib/asset-writer";
import { prisma } from "@/lib/prisma";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { regenerateSummaries } from "@/lib/summary-service";
import {
  setSummaryGenerator,
  type SummaryDraft,
  type SummaryGenerator,
} from "@/lib/summary-generator";

const BODY = "# pdf-skill\n\n把 PDF 转成 Markdown。";

afterEach(() => {
  setSummaryGenerator(null);
});

/** 假的简介生成器（可计数）。 */
function fakeGenerator(draft: Partial<SummaryDraft> = {}) {
  const calls: unknown[] = [];
  const generator: SummaryGenerator = {
    async generate(input) {
      calls.push(input);
      return {
        summaryZh: draft.summaryZh ?? "AI 写的中文简介。",
        whenToUse: draft.whenToUse ?? "批量处理 PDF 时使用。",
        howToUse: draft.howToUse ?? "安装后直接调用。",
        tags: [],
        source: draft.source ?? "LLM",
      };
    },
  };
  return { generator, calls };
}

/** 造一个账号 + 会话。 */
async function createUser(options: {
  email: string;
  role?: "USER" | "MODERATOR" | "ADMIN";
}): Promise<{ id: string; token: string }> {
  const user = await prisma.user.create({
    data: {
      email: options.email,
      role: options.role ?? "USER",
      emailVerifiedAt: new Date(),
    },
  });
  const { token } = await createSession({ userId: user.id });
  return { id: user.id, token };
}

/** 造一个带会话 cookie 的 PATCH 请求。 */
function overrideRequest(slug: string, body: unknown, token?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) {
    headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
  }
  return new Request(`http://localhost/api/assets/${slug}/summary`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });
}

/** 种一条 FULL 档的 Skill（走生产同一条写入路径）。 */
async function seedSkill(slug = "example-skills-pdf-skill"): Promise<void> {
  await writeAsset({
    kind: "SKILL",
    slug,
    displayName: "pdf-skill",
    license: "MIT",
    contentBody: BODY,
    summaryZh: "AI 写的中文简介。",
    summarySource: "LLM",
    whenToUse: "批量处理 PDF 时使用。",
    howToUse: "安装后直接调用。",
    repoOwner: "example",
    repoName: "skills",
    repoUrl: "https://github.com/example/skills",
    upstreamUrl: "https://raw.githubusercontent.com/example/skills/main/skills/pdf/SKILL.md",
    sourceId: "github-repo",
    detail: {
      skill: {
        frontmatter: { name: "pdf-skill", description: "把 PDF 转成 Markdown。" },
        skillPath: "skills/pdf/SKILL.md",
      },
    },
  });
}

/** 种一条 FULL 档的 Prompt（走生产同一条写入路径）。 */
async function seedPrompt(slug = "example-prompts-music-prompt"): Promise<void> {
  await writeAsset({
    kind: "PROMPT",
    slug,
    displayName: "Instrumental Companion",
    license: "MIT",
    contentBody: "Upbeat 80s-influenced synth-pop anthem.",
    summaryZh: "AI 写的中文简介。",
    summarySource: "LLM",
    whenToUse: "批量处理 PDF 时使用。",
    howToUse: "安装后直接调用。",
    repoOwner: "example",
    repoName: "prompts",
    repoUrl: "https://github.com/example/prompts",
    upstreamUrl: "https://raw.githubusercontent.com/example/prompts/main/prompts.csv",
    sourceId: "github-repo",
    detail: {
      prompt: {
        modality: "MUSIC",
        act: "Instrumental Companion",
        toolTags: ["suno"],
        promptBody: "Upbeat 80s-influenced synth-pop anthem.",
      },
    },
  });
}

describe("详情页：中文简介 + 何时用 / 怎么用", () => {
  it("简介、两个分区、来源标注与原仓库链接都在页面上", async () => {
    await seedSkill();

    const element = await SkillDetailPage({
      params: Promise.resolve({ slug: "example-skills-pdf-skill" }),
    });
    const html = renderToStaticMarkup(element);

    // 中文简介。
    expect(html).toContain("AI 写的中文简介。");
    // 「何时用」与「怎么用」分区可见。
    expect(html).toContain("何时用");
    expect(html).toContain("怎么用");
    expect(html).toContain("批量处理 PDF 时使用。");
    expect(html).toContain("安装后直接调用。");
    // 来源标注。
    expect(html).toContain("AI 生成，版权归原作者");
    // 原仓库链接与许可证标识。
    expect(html).toContain("https://github.com/example/skills");
    expect(html).toContain("mit");
  });

  it("来源是人工时，页面显示「人工撰写」而不是「AI 生成」", async () => {
    await seedSkill();

    const operator = await createUser({ email: "operator@example.com", role: "MODERATOR" });
    const response = await overrideRoute(
      overrideRequest(
        "example-skills-pdf-skill",
        { summaryZh: "人工改写的简介。", whenToUse: "何时用（人工）。", howToUse: "怎么用（人工）。" },
        operator.token,
      ),
      { params: Promise.resolve({ slug: "example-skills-pdf-skill" }) },
    );
    expect(response.status).toBe(200);

    const element = await SkillDetailPage({
      params: Promise.resolve({ slug: "example-skills-pdf-skill" }),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("人工改写的简介。");
    expect(html).toContain("人工撰写");
    expect(html).not.toContain("AI 生成，版权归原作者");
    expect(html).toContain("何时用（人工）。");
    expect(html).toContain("怎么用（人工）。");
  });
});

describe("列表页与搜索结果项", () => {
  it("列表页展示中文简介与「何时用 / 怎么用」", async () => {
    await seedSkill();

    const element = await SkillListPage();
    const html = renderToStaticMarkup(element);

    expect(html).toContain("AI 写的中文简介。");
    expect(html).toContain("何时用");
    expect(html).toContain("怎么用");
    expect(html).toContain("批量处理 PDF 时使用。");
    expect(html).toContain("安装后直接调用。");
  });

  it("搜索结果项展示中文简介与「何时用 / 怎么用」", async () => {
    await seedSkill();

    const element = await SearchPage({
      searchParams: Promise.resolve({ q: "pdf" }),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain('href="/skills/example-skills-pdf-skill"');
    expect(html).toContain("AI 写的中文简介。");
    expect(html).toContain("何时用");
    expect(html).toContain("怎么用");
    expect(html).toContain("批量处理 PDF 时使用。");
    expect(html).toContain("安装后直接调用。");
  });
});

describe("人工覆盖接口", () => {
  it("未登录 → 401", async () => {
    await seedSkill();

    const response = await overrideRoute(
      overrideRequest("example-skills-pdf-skill", { summaryZh: "匿名改写" }),
      { params: Promise.resolve({ slug: "example-skills-pdf-skill" }) },
    );

    expect(response.status).toBe(401);
  });

  it("普通用户改别人的资产 → 403", async () => {
    await seedSkill();
    const stranger = await createUser({ email: "stranger@example.com" });

    const response = await overrideRoute(
      overrideRequest("example-skills-pdf-skill", { summaryZh: "我来改" }, stranger.token),
      { params: Promise.resolve({ slug: "example-skills-pdf-skill" }) },
    );

    expect(response.status).toBe(403);
  });

  it("资产作者可以覆盖自己的资产", async () => {
    await seedSkill();
    const author = await createUser({ email: "author@example.com" });

    // 留一条发布记录 —— 这条资产就成了这个作者的。
    const asset = await prisma.asset.findUniqueOrThrow({
      where: { slug: "example-skills-pdf-skill" },
    });
    await prisma.userPublishedAsset.create({
      data: { userId: author.id, assetId: asset.id },
    });

    const response = await overrideRoute(
      overrideRequest(
        "example-skills-pdf-skill",
        { summaryZh: "作者自己改写的简介。" },
        author.token,
      ),
      { params: Promise.resolve({ slug: "example-skills-pdf-skill" }) },
    );

    expect(response.status).toBe(200);

    const after = await prisma.asset.findUniqueOrThrow({
      where: { slug: "example-skills-pdf-skill" },
    });
    expect(after.summarySource).toBe("HUMAN");
    expect(after.summaryZh).toBe("作者自己改写的简介。");
    expect(after.summaryOverriddenBy).toBe(author.id);
  });

  it("运营可以覆盖任何资产", async () => {
    await seedSkill();
    const operator = await createUser({ email: "mod@example.com", role: "MODERATOR" });

    const response = await overrideRoute(
      overrideRequest(
        "example-skills-pdf-skill",
        { summaryZh: "运营改写的简介。", whenToUse: "何时用。", howToUse: "怎么用。" },
        operator.token,
      ),
      { params: Promise.resolve({ slug: "example-skills-pdf-skill" }) },
    );

    expect(response.status).toBe(200);

    const asset = await prisma.asset.findUniqueOrThrow({
      where: { slug: "example-skills-pdf-skill" },
    });
    expect(asset.summarySource).toBe("HUMAN");
    expect(asset.summaryZh).toBe("运营改写的简介。");
    expect(asset.summaryOverriddenAt).not.toBeNull();
    expect(asset.summaryOverriddenBy).toBe(operator.id);
  });

  it("简介为空 → 400", async () => {
    await seedSkill();
    const operator = await createUser({ email: "mod2@example.com", role: "ADMIN" });

    const response = await overrideRoute(
      overrideRequest("example-skills-pdf-skill", { summaryZh: "   " }, operator.token),
      { params: Promise.resolve({ slug: "example-skills-pdf-skill" }) },
    );

    expect(response.status).toBe(400);
  });

  it("资产不存在 → 404", async () => {
    const operator = await createUser({ email: "mod3@example.com", role: "MODERATOR" });

    const response = await overrideRoute(
      overrideRequest("not-there", { summaryZh: "改写" }, operator.token),
      { params: Promise.resolve({ slug: "not-there" }) },
    );

    expect(response.status).toBe(404);
  });
});

describe("人工覆盖之后", () => {
  it("批量重跑不覆盖它", async () => {
    await seedSkill();
    const { generator, calls } = fakeGenerator({ summaryZh: "重跑后的简介。" });
    setSummaryGenerator(generator);

    const operator = await createUser({ email: "mod4@example.com", role: "MODERATOR" });
    const response = await overrideRoute(
      overrideRequest(
        "example-skills-pdf-skill",
        { summaryZh: "人工改写的简介。", whenToUse: "何时。", howToUse: "怎么。" },
        operator.token,
      ),
      { params: Promise.resolve({ slug: "example-skills-pdf-skill" }) },
    );
    expect(response.status).toBe(200);

    const report = await regenerateSummaries({}, { generator });
    expect(report.skippedOverridden).toBe(1);
    expect(report.regenerated).toBe(0);
    expect(calls).toHaveLength(0);

    const asset = await prisma.asset.findUniqueOrThrow({
      where: { slug: "example-skills-pdf-skill" },
    });
    expect(asset.summaryZh).toBe("人工改写的简介。");
    expect(asset.summarySource).toBe("HUMAN");
  });
});

describe("Prompt 详情页：何时用 / 怎么用", () => {
  it("简介、两个分区、来源标注与原仓库链接都在页面上", async () => {
    await seedPrompt();

    const element = await PromptDetailPage({
      params: Promise.resolve({ slug: "example-prompts-music-prompt" }),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("AI 写的中文简介。");
    expect(html).toContain("何时用");
    expect(html).toContain("怎么用");
    expect(html).toContain("批量处理 PDF 时使用。");
    expect(html).toContain("安装后直接调用。");
    expect(html).toContain("AI 生成，版权归原作者");
    expect(html).toContain("https://github.com/example/prompts");
    expect(html).toContain("mit");
  });

  it("Prompt 列表页也展示「何时用 / 怎么用」", async () => {
    await seedPrompt();

    const element = await PromptListPage({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("何时用");
    expect(html).toContain("怎么用");
    expect(html).toContain("批量处理 PDF 时使用。");
    expect(html).toContain("安装后直接调用。");
  });
});

describe("模型失败时", () => {
  it("资产仍能入库，简介降级显示，来源标记为 TEMPLATE", async () => {
    setSummaryGenerator({
      async generate() {
        throw new Error("LLM 挂了");
      },
    });

    await writeAsset({
      kind: "SKILL",
      slug: "broken-model",
      displayName: "pdf-skill",
      license: "MIT",
      contentBody: BODY,
      summaryZh: "降级后的模板简介。",
      summarySource: "TEMPLATE",
      whenToUse: null,
      howToUse: null,
      repoOwner: "example",
      repoName: "skills",
    });

    const asset = await prisma.asset.findUniqueOrThrow({ where: { slug: "broken-model" } });
    expect(asset.summarySource).toBe("TEMPLATE");
    expect(asset.summaryZh).toBe("降级后的模板简介。");
    expect(asset.contentBody).toBe(BODY);

    const element = await SkillDetailPage({ params: Promise.resolve({ slug: "broken-model" }) });
    const html = renderToStaticMarkup(element);
    expect(html).toContain("降级后的模板简介。");
    expect(html).toContain("模板生成");
  });
});
