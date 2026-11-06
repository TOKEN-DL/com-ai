/**
 * 用户发布自己的资产（票 #11）—— HTTP 边界测试。
 *
 * 验的是**外部可观察行为**（spec 的 seam 2：Next.js 路由 + 真实 Postgres）：
 *   - 门槛：未登录进不了发布流程；邮箱没验证也不行；
 *   - 发布后：资产落库、简介初稿生成、来源标记正确；
 *   - 许可证分层：声明可再分发 → FULL 档；声明无许可 → METADATA_ONLY 档
 *     （**没有正文、没有基于原文的简介**，但流程照样顺畅）；
 *   - 降级：LLM 挂了不阻断发布，来源标成 TEMPLATE；
 *   - 审核：自动关键词过滤 → 审核中（下架）；运营审核 → 状态与意见对发布者可见；
 *   - 举报：用户举报 → 下架待抽查；
 *   - 二期预留：版本与依赖字段已落库。
 *
 * 简介生成器按 spec 的 port 约定注入确定性假实现。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET as assetsRoute } from "@/app/api/assets/route";
import { GET as skillsRoute } from "@/app/api/skills/route";
import { GET as mineRoute } from "@/app/api/publish/mine/route";
import { POST as publishRoute } from "@/app/api/publish/route";
import { POST as reportRoute } from "@/app/api/publish/report/route";
import { POST as reviewRoute } from "@/app/api/moderation/published/[id]/route";
import { POST as resolveReportRoute } from "@/app/api/moderation/reports/[id]/route";
import { prisma } from "@/lib/prisma";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import {
  setSummaryGenerator,
  type SummaryDraft,
  type SummaryGenerator,
} from "@/lib/summary-generator";

const BODY = "# 我的 Skill\n\n这是 SKILL.md 正文。";

/** 造一个带会话 cookie 的请求。 */
function withCookie(token: string, url = "http://localhost/api/publish"): Request {
  return new Request(url, { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` } });
}

/** 造一个带会话 cookie 的 JSON 请求。 */
function jsonRequest(url: string, body: unknown, token?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) {
    headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
  }
  return new Request(url, { method: "POST", headers, body: JSON.stringify(body) });
}

/** 造一个账号（默认邮箱已验证）。 */
async function createUser(options: {
  email: string;
  role?: "USER" | "MODERATOR" | "ADMIN";
  verified?: boolean;
}): Promise<{ id: string; token: string }> {
  const user = await prisma.user.create({
    data: {
      email: options.email,
      role: options.role ?? "USER",
      emailVerifiedAt: options.verified === false ? null : new Date(),
    },
  });
  const { token } = await createSession({ userId: user.id });
  return { id: user.id, token };
}

/** 假的简介生成器：返回固定初稿（spec 的 port 约定）。 */
function fakeGenerator(draft: Partial<SummaryDraft> = {}): SummaryGenerator {
  return {
    async generate() {
      return {
        summaryZh: draft.summaryZh ?? "AI 写的中文简介。",
        whenToUse: draft.whenToUse ?? "批量处理 PDF 时使用。",
        howToUse: draft.howToUse ?? "安装后直接调用。",
        tags: draft.tags ?? ["文档处理"],
        source: draft.source ?? "LLM",
      };
    },
  };
}

/** 永远失败的生成器：模拟 LLM 挂了。 */
const brokenGenerator: SummaryGenerator = {
  async generate() {
    throw new Error("LLM 挂了");
  },
};

/** 发布请求的默认入参。 */
function publishPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "SKILL",
    displayName: "我的 PDF Skill",
    repoUrl: "https://github.com/example/my-pdf-skill",
    license: "MIT",
    description: "批量把 PDF 转成 Markdown。",
    contentBody: BODY,
    ...overrides,
  };
}

beforeEach(() => {
  setSummaryGenerator(fakeGenerator());
});

afterEach(() => {
  setSummaryGenerator(null);
});

describe("发布门槛", () => {
  it("未登录用户进不了发布流程：401，且不留下任何资产", async () => {
    const response = await publishRoute(
      jsonRequest("http://localhost/api/publish", publishPayload()),
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string; loginUrl: string };
    expect(body.error).toBe("unauthenticated");
    expect(body.loginUrl).toBe("/login");
    expect(await prisma.asset.count()).toBe(0);
    expect(await prisma.userPublishedAsset.count()).toBe(0);
  });

  it("登录了但邮箱没验证：403", async () => {
    const user = await createUser({ email: "unverified@example.com", verified: false });

    const response = await publishRoute(
      jsonRequest("http://localhost/api/publish", publishPayload(), user.token),
    );

    expect(response.status).toBe(403);
    expect(await prisma.asset.count()).toBe(0);
  });

  it("「我的发布」同样需要登录", async () => {
    const response = await mineRoute(new Request("http://localhost/api/publish/mine"));
    expect(response.status).toBe(401);
  });
});

describe("发布成功（FULL 档：声明了允许再分发的许可）", () => {
  it("资产落库、内容档位是 FULL、简介初稿来自 AI 并标注为 AI 生成", async () => {
    const user = await createUser({ email: "publisher@example.com" });

    const response = await publishRoute(
      jsonRequest("http://localhost/api/publish", publishPayload(), user.token),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      ok: boolean;
      slug: string;
      status: string;
      summarySource: string;
      aiGenerated: boolean;
      whenToUse: string;
      contentTier: string;
    };
    expect(body.ok).toBe(true);
    expect(body.slug).toBe("example-my-pdf-skill");
    expect(body.status).toBe("PUBLISHED");
    expect(body.summarySource).toBe("LLM");
    // 「标注为 AI 生成」——页面据此显示「AI 生成，版权归原作者」。
    expect(body.aiGenerated).toBe(true);
    expect(body.whenToUse).toBe("批量处理 PDF 时使用。");
    expect(body.contentTier).toBe("FULL");

    const asset = await prisma.asset.findUniqueOrThrow({ where: { slug: body.slug } });
    expect(asset.contentTier).toBe("FULL");
    expect(asset.contentBody).toBe(BODY);
    expect(asset.license).toBe("mit");
    expect(asset.sourceId).toBe("user");
    expect(asset.summarySource).toBe("LLM");

    const detail = await prisma.skillDetail.findUniqueOrThrow({ where: { assetId: asset.id } });
    expect(detail.whenToUse).toBe("批量处理 PDF 时使用。");
    expect(detail.howToUse).toBe("安装后直接调用。");
  });

  it("发布记录带上状态与发布者自己写的简介", async () => {
    const user = await createUser({ email: "publisher2@example.com" });

    await publishRoute(
      jsonRequest("http://localhost/api/publish", publishPayload(), user.token),
    );

    const publication = await prisma.userPublishedAsset.findFirstOrThrow();
    expect(publication.userId).toBe(user.id);
    expect(publication.status).toBe("PUBLISHED");
    expect(publication.note).toBe("批量把 PDF 转成 Markdown。");
  });

  it("发布后资产进入可浏览范围", async () => {
    const user = await createUser({ email: "publisher3@example.com" });
    await publishRoute(jsonRequest("http://localhost/api/publish", publishPayload(), user.token));

    const response = await skillsRoute(new Request("http://localhost/api/skills"));
    const body = (await response.json()) as { items: { slug: string }[] };
    expect(body.items.map((item) => item.slug)).toContain("example-my-pdf-skill");
  });
});

describe("许可证分层对用户发布同样生效", () => {
  it("声明无许可证：METADATA_ONLY 档，不存正文、不生成基于原文的简介，但发布照样成功", async () => {
    const user = await createUser({ email: "nolicense@example.com" });

    const response = await publishRoute(
      jsonRequest(
        "http://localhost/api/publish",
        publishPayload({ license: null, description: "我自己写的简介。" }),
        user.token,
      ),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      contentTier: string;
      summarySource: string;
      summaryZh: string;
      whenToUse: string | null;
    };
    expect(body.contentTier).toBe("METADATA_ONLY");
    // 没有基于原文的简介 → 来源标记不是 LLM。
    expect(body.summarySource).toBe("HUMAN");
    expect(body.summaryZh).toBe("我自己写的简介。");
    expect(body.whenToUse).toBeNull();

    const asset = await prisma.asset.findUniqueOrThrow({
      where: { slug: "example-my-pdf-skill" },
    });
    // 正文不复制 —— 设计如此（数据库触发器也会兜底）。
    expect(asset.contentBody).toBeNull();

    const detail = await prisma.skillDetail.findUniqueOrThrow({ where: { assetId: asset.id } });
    expect(detail.whenToUse).toBeNull();
    expect(detail.howToUse).toBeNull();
  });

  it("声明限制性许可（GPL-3.0）：同样是 METADATA_ONLY 档", async () => {
    const user = await createUser({ email: "gpl@example.com" });

    const response = await publishRoute(
      jsonRequest(
        "http://localhost/api/publish",
        publishPayload({ license: "GPL-3.0" }),
        user.token,
      ),
    );

    expect(response.status).toBe(201);
    const asset = await prisma.asset.findUniqueOrThrow({
      where: { slug: "example-my-pdf-skill" },
    });
    expect(asset.contentTier).toBe("METADATA_ONLY");
    expect(asset.contentBody).toBeNull();
  });
});

describe("简介生成失败不阻断发布", () => {
  it("生成器抛异常：发布照样成功，来源标成 TEMPLATE", async () => {
    setSummaryGenerator(brokenGenerator);
    const user = await createUser({ email: "llm-down@example.com" });

    const response = await publishRoute(
      jsonRequest("http://localhost/api/publish", publishPayload(), user.token),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { summarySource: string; summaryZh: string };
    expect(body.summarySource).toBe("TEMPLATE");
    expect(body.summaryZh.length).toBeGreaterThan(0);

    const asset = await prisma.asset.findUniqueOrThrow({
      where: { slug: "example-my-pdf-skill" },
    });
    expect(asset.summarySource).toBe("TEMPLATE");
    expect(asset.contentTier).toBe("FULL");
  });
});

describe("自动关键词过滤", () => {
  it("简介命中过滤词：状态变审核中（PENDING），资产被下架", async () => {
    const user = await createUser({ email: "spammer@example.com" });

    const response = await publishRoute(
      jsonRequest(
        "http://localhost/api/publish",
        publishPayload({ description: "加微信领取福利，加微信加微信" }),
        user.token,
      ),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { status: string; filtered: boolean };
    expect(body.status).toBe("PENDING");
    expect(body.filtered).toBe(true);

    const publication = await prisma.userPublishedAsset.findFirstOrThrow();
    expect(publication.status).toBe("PENDING");
    expect(publication.filteredReason).toContain("加微信");
  });

  it("被下架的资产不出现在列表与批量查询里", async () => {
    const user = await createUser({ email: "spammer2@example.com" });
    await publishRoute(
      jsonRequest(
        "http://localhost/api/publish",
        publishPayload({ description: "加微信领取福利" }),
        user.token,
      ),
    );

    const skills = await skillsRoute(new Request("http://localhost/api/skills"));
    const skillsBody = (await skills.json()) as { items: { slug: string }[] };
    expect(skillsBody.items.map((item) => item.slug)).not.toContain("example-my-pdf-skill");

    const assets = await assetsRoute(
      new Request("http://localhost/api/assets?slugs=example-my-pdf-skill"),
    );
    const assetsBody = (await assets.json()) as { items: unknown[] };
    expect(assetsBody.items).toHaveLength(0);
  });
});

describe("我的发布列表", () => {
  it("看得到自己的发布、状态与审核意见；看不到别人的", async () => {
    const publisher = await createUser({ email: "mine@example.com" });
    const other = await createUser({ email: "other@example.com" });

    await publishRoute(jsonRequest("http://localhost/api/publish", publishPayload(), publisher.token));
    await publishRoute(
      jsonRequest(
        "http://localhost/api/publish",
        publishPayload({ repoUrl: "https://github.com/example/other-skill" }),
        other.token,
      ),
    );

    const response = await mineRoute(withCookie(publisher.token, "http://localhost/api/publish/mine"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: { slug: string; status: string; statusLabel: string; reviewNote: string | null }[];
    };

    expect(body.items).toHaveLength(1);
    expect(body.items[0].slug).toBe("example-my-pdf-skill");
    expect(body.items[0].status).toBe("PUBLISHED");
    expect(body.items[0].statusLabel).toBe("已发布");
    expect(body.items[0].reviewNote).toBeNull();
  });
});

describe("运营审核", () => {
  it("驳回后状态变已拒绝，审核意见对发布者可见", async () => {
    const publisher = await createUser({ email: "reviewed@example.com" });
    const moderator = await createUser({ email: "mod@example.com", role: "MODERATOR" });

    await publishRoute(jsonRequest("http://localhost/api/publish", publishPayload(), publisher.token));

    const publication = await prisma.userPublishedAsset.findFirstOrThrow();

    const review = await reviewRoute(
      jsonRequest(
        "http://localhost/api/moderation/published/x",
        { action: "reject", note: "仓库里没有 SKILL.md。" },
        moderator.token,
      ),
      { params: Promise.resolve({ id: publication.id }) },
    );

    expect(review.status).toBe(200);

    const mine = await mineRoute(withCookie(publisher.token, "http://localhost/api/publish/mine"));
    const body = (await mine.json()) as {
      items: { status: string; statusLabel: string; reviewNote: string | null }[];
    };
    expect(body.items[0].status).toBe("REJECTED");
    expect(body.items[0].statusLabel).toBe("已拒绝");
    expect(body.items[0].reviewNote).toBe("仓库里没有 SKILL.md。");
  });

  it("放行后状态变已发布", async () => {
    const publisher = await createUser({ email: "approved@example.com" });
    const moderator = await createUser({ email: "mod2@example.com", role: "ADMIN" });

    await publishRoute(
      jsonRequest(
        "http://localhost/api/publish",
        publishPayload({ description: "加微信领取福利" }),
        publisher.token,
      ),
    );
    const publication = await prisma.userPublishedAsset.findFirstOrThrow();
    expect(publication.status).toBe("PENDING");

    const review = await reviewRoute(
      jsonRequest(
        "http://localhost/api/moderation/published/x",
        { action: "approve", note: "误伤，放行。" },
        moderator.token,
      ),
      { params: Promise.resolve({ id: publication.id }) },
    );

    expect(review.status).toBe(200);
    const updated = await prisma.userPublishedAsset.findFirstOrThrow();
    expect(updated.status).toBe("PUBLISHED");
    expect(updated.reviewedAt).not.toBeNull();
  });

  it("驳回不写审核意见 → 400", async () => {
    const publisher = await createUser({ email: "note@example.com" });
    const moderator = await createUser({ email: "mod3@example.com", role: "MODERATOR" });
    await publishRoute(jsonRequest("http://localhost/api/publish", publishPayload(), publisher.token));
    const publication = await prisma.userPublishedAsset.findFirstOrThrow();

    const review = await reviewRoute(
      jsonRequest(
        "http://localhost/api/moderation/published/x",
        { action: "reject" },
        moderator.token,
      ),
      { params: Promise.resolve({ id: publication.id }) },
    );

    expect(review.status).toBe(400);
  });

  it("普通用户不能审核：403", async () => {
    const publisher = await createUser({ email: "notmod@example.com" });
    await publishRoute(jsonRequest("http://localhost/api/publish", publishPayload(), publisher.token));
    const publication = await prisma.userPublishedAsset.findFirstOrThrow();

    const review = await reviewRoute(
      jsonRequest(
        "http://localhost/api/moderation/published/x",
        { action: "approve" },
        publisher.token,
      ),
      { params: Promise.resolve({ id: publication.id }) },
    );

    expect(review.status).toBe(403);
  });
});

describe("用户举报", () => {
  it("举报用户发布的资产：落举报记录，资产下架待抽查", async () => {
    const publisher = await createUser({ email: "reported@example.com" });
    const reporter = await createUser({ email: "reporter@example.com" });

    await publishRoute(jsonRequest("http://localhost/api/publish", publishPayload(), publisher.token));

    const response = await reportRoute(
      jsonRequest("http://localhost/api/publish/report", {
        assetSlug: "example-my-pdf-skill",
        reason: "COPYRIGHT",
        detail: "这不是我的仓库。",
      }, reporter.token),
    );

    expect(response.status).toBe(201);

    const report = await prisma.report.findFirstOrThrow();
    expect(report.target).toBe("ASSET");
    expect(report.reason).toBe("COPYRIGHT");
    expect(report.reporterUserId).toBe(reporter.id);

    const publication = await prisma.userPublishedAsset.findFirstOrThrow();
    expect(publication.status).toBe("PENDING");
    expect(publication.reportedCount).toBe(1);
  });

  it("游客也能举报（不强制登录）", async () => {
    const publisher = await createUser({ email: "guest-report@example.com" });
    await publishRoute(jsonRequest("http://localhost/api/publish", publishPayload(), publisher.token));

    const response = await reportRoute(
      jsonRequest("http://localhost/api/publish/report", {
        assetSlug: "example-my-pdf-skill",
        reason: "SPAM",
      }),
    );

    expect(response.status).toBe(201);
    const report = await prisma.report.findFirstOrThrow();
    expect(report.reporterUserId).toBeNull();
  });

  it("举报不存在的资产 → 404；理由不受支持 → 400", async () => {
    const missing = await reportRoute(
      jsonRequest("http://localhost/api/publish/report", {
        assetSlug: "not-exists",
        reason: "SPAM",
      }),
    );
    expect(missing.status).toBe(404);

    const publisher = await createUser({ email: "badreason@example.com" });
    await publishRoute(jsonRequest("http://localhost/api/publish", publishPayload(), publisher.token));

    const bad = await reportRoute(
      jsonRequest("http://localhost/api/publish/report", {
        assetSlug: "example-my-pdf-skill",
        reason: "WHATEVER",
      }),
    );
    expect(bad.status).toBe(400);
  });

  it("举报成立 → 资产被驳回；举报不成立 → 资产恢复展示", async () => {
    const publisher = await createUser({ email: "case@example.com" });
    const moderator = await createUser({ email: "mod4@example.com", role: "MODERATOR" });

    await publishRoute(jsonRequest("http://localhost/api/publish", publishPayload(), publisher.token));
    await reportRoute(
      jsonRequest("http://localhost/api/publish/report", {
        assetSlug: "example-my-pdf-skill",
        reason: "ILLEGAL",
      }),
    );

    const report = await prisma.report.findFirstOrThrow();

    const resolved = await resolveReportRoute(
      jsonRequest(
        "http://localhost/api/moderation/reports/x",
        { action: "resolve", note: "确实违规。" },
        moderator.token,
      ),
      { params: Promise.resolve({ id: report.id }) },
    );
    expect(resolved.status).toBe(200);
    let publication = await prisma.userPublishedAsset.findFirstOrThrow();
    expect(publication.status).toBe("REJECTED");

    // 再举报一次，然后判定不成立 → 恢复展示。
    await reportRoute(
      jsonRequest("http://localhost/api/publish/report", {
        assetSlug: "example-my-pdf-skill",
        reason: "SPAM",
      }),
    );
    const second = await prisma.report.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    const dismissed = await resolveReportRoute(
      jsonRequest(
        "http://localhost/api/moderation/reports/x",
        { action: "dismiss" },
        moderator.token,
      ),
      { params: Promise.resolve({ id: second.id }) },
    );
    expect(dismissed.status).toBe(200);
    publication = await prisma.userPublishedAsset.findFirstOrThrow();
    expect(publication.status).toBe("PUBLISHED");
  });
});

describe("重复发布与冲突", () => {
  it("同一个用户重复发布同一个仓库：更新而不是新建", async () => {
    const user = await createUser({ email: "again@example.com" });

    await publishRoute(jsonRequest("http://localhost/api/publish", publishPayload(), user.token));
    const second = await publishRoute(
      jsonRequest(
        "http://localhost/api/publish",
        publishPayload({ displayName: "改了个名字" }),
        user.token,
      ),
    );

    expect(second.status).toBe(201);
    expect(await prisma.asset.count()).toBe(1);
    expect(await prisma.userPublishedAsset.count()).toBe(1);
    const asset = await prisma.asset.findFirstOrThrow();
    expect(asset.displayName).toBe("改了个名字");
  });

  it("另一个用户发布同一个仓库 → 409", async () => {
    const first = await createUser({ email: "first@example.com" });
    const second = await createUser({ email: "second@example.com" });

    await publishRoute(jsonRequest("http://localhost/api/publish", publishPayload(), first.token));
    const conflict = await publishRoute(
      jsonRequest("http://localhost/api/publish", publishPayload(), second.token),
    );

    expect(conflict.status).toBe(409);
    const body = (await conflict.json()) as { error: string; message: string };
    expect(body.error).toBe("SLUG_TAKEN");
  });

  it("仓库地址不合法 → 400", async () => {
    const user = await createUser({ email: "badurl@example.com" });
    const response = await publishRoute(
      jsonRequest(
        "http://localhost/api/publish",
        publishPayload({ repoUrl: "not-a-repo" }),
        user.token,
      ),
    );
    expect(response.status).toBe(400);
  });
});

describe("为二期预留的字段", () => {
  it("发布时带上版本号与依赖清单路径，落进预留字段", async () => {
    const user = await createUser({ email: "v2@example.com" });

    await publishRoute(
      jsonRequest(
        "http://localhost/api/publish",
        publishPayload({ version: "1.2.0", manifestPath: "com-ai.manifest.json" }),
        user.token,
      ),
    );

    const publication = await prisma.userPublishedAsset.findFirstOrThrow();
    expect(publication.latestVersion).toBe("1.2.0");
    expect(publication.manifestPath).toBe("com-ai.manifest.json");

    const asset = await prisma.asset.findFirstOrThrow();
    expect(asset.currentVersion).toBe("1.2.0");
  });
});
