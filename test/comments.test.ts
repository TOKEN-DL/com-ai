/**
 * 评论、回复与关键词过滤（票 #10 验收标准第 1、2、3 条）。
 *
 * Seam 2 —— HTTP 边界：路由处理器对着**真实测试 Postgres** 跑。
 *
 * 关注三件事：
 *   1. 游客态拿不到「发表评论」这条路，登录用户可以；
 *   2. 回复挂在父评论下，形成两级讨论串；
 *   3. 命中关键词过滤词的评论被拦下并给出明确提示。
 */
import { describe, expect, it } from "vitest";

import {
  GET as listComments,
  POST as postComment,
} from "@/app/api/assets/[slug]/comments/route";
import { prisma } from "@/lib/prisma";
import { createSession, SESSION_COOKIE } from "@/lib/session";

const SLUG = "comment-skill";

async function seedAsset(): Promise<void> {
  await prisma.asset.create({
    data: { kind: "SKILL", slug: SLUG, displayName: "评论用 Skill", license: "MIT" },
  });
}

async function seedUser(email: string, displayName?: string): Promise<{ id: string; token: string }> {
  const user = await prisma.user.create({
    data: { email, emailVerifiedAt: new Date(), displayName: displayName ?? null },
  });
  const { token } = await createSession({ userId: user.id });
  return { id: user.id, token };
}

/** 造一个带会话 cookie 的请求。 */
function authed(token: string, url: string, body?: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function guest(url: string, body?: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("发表评论：必须登录", () => {
  it("游客态被拦下，拿到 401 + 引导登录的提示，且没有落库", async () => {
    await seedAsset();

    const response = await postComment(
      guest("http://localhost/api/assets/comment-skill/comments", { body: "我也觉得好用" }),
      { params: Promise.resolve({ slug: SLUG }) },
    );

    expect(response.status).toBe(401);

    const payload = (await response.json()) as {
      error: string;
      message: string;
      loginUrl: string;
    };
    expect(payload.error).toBe("unauthenticated");
    expect(payload.loginUrl).toBe("/login");
    expect(payload.message).toContain("登录");

    expect(await prisma.comment.count()).toBe(0);
  });

  it("登录用户能发表评论，落库并归属到账号", async () => {
    await seedAsset();
    const user = await seedUser("commenter@example.com");

    const response = await postComment(
      authed(user.token, "http://localhost/api/assets/comment-skill/comments", {
        body: "这个 Skill 处理 PDF 很好用",
      }),
      { params: Promise.resolve({ slug: SLUG }) },
    );

    expect(response.status).toBe(201);

    const rows = await prisma.comment.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(user.id);
    expect(rows[0].body).toBe("这个 Skill 处理 PDF 很好用");
    expect(rows[0].status).toBe("VISIBLE");
    expect(rows[0].parentId).toBeNull();
  });

  it("空评论被拒，给出用户能看懂的提示", async () => {
    await seedAsset();
    const user = await seedUser("empty@example.com");

    const response = await postComment(
      authed(user.token, "http://localhost/api/assets/comment-skill/comments", { body: "   " }),
      { params: Promise.resolve({ slug: SLUG }) },
    );

    expect(response.status).toBe(400);
    expect(await prisma.comment.count()).toBe(0);
  });

  it("资产不存在返回 404", async () => {
    const user = await seedUser("nowhere@example.com");

    const response = await postComment(
      authed(user.token, "http://localhost/api/assets/nope/comments", { body: "你好" }),
      { params: Promise.resolve({ slug: "nope" }) },
    );

    expect(response.status).toBe(404);
  });
});

describe("回复：形成两级讨论串", () => {
  it("回复挂在父评论下，列表里能看到顶层评论与它的回复", async () => {
    await seedAsset();
    const user = await seedUser("thread@example.com");

    const top = await postComment(
      authed(user.token, "http://localhost/api/assets/comment-skill/comments", {
        body: "顶层评论",
      }),
      { params: Promise.resolve({ slug: SLUG }) },
    );
    const topBody = (await top.json()) as { comment: { id: string } };

    const reply = await postComment(
      authed(user.token, "http://localhost/api/assets/comment-skill/comments", {
        body: "这是一条回复",
        parentId: topBody.comment.id,
      }),
      { params: Promise.resolve({ slug: SLUG }) },
    );

    expect(reply.status).toBe(201);

    const listed = await listComments(new Request("http://localhost/api/assets/x/comments"), {
      params: Promise.resolve({ slug: SLUG }),
    });
    expect(listed.status).toBe(200);

    const payload = (await listed.json()) as {
      items: { body: string; replies: { body: string }[] }[];
    };
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0].body).toBe("顶层评论");
    expect(payload.items[0].replies).toHaveLength(1);
    expect(payload.items[0].replies[0].body).toBe("这是一条回复");
  });

  it("回复不能再挂回复（讨论串是两级）", async () => {
    await seedAsset();
    const user = await seedUser("deep@example.com");

    const top = await postComment(
      authed(user.token, "http://localhost/api/assets/comment-skill/comments", { body: "顶层" }),
      { params: Promise.resolve({ slug: SLUG }) },
    );
    const topBody = (await top.json()) as { comment: { id: string } };

    const reply = await postComment(
      authed(user.token, "http://localhost/api/assets/comment-skill/comments", {
        body: "回复",
        parentId: topBody.comment.id,
      }),
      { params: Promise.resolve({ slug: SLUG }) },
    );
    const replyBody = (await reply.json()) as { comment: { id: string } };

    const tooDeep = await postComment(
      authed(user.token, "http://localhost/api/assets/comment-skill/comments", {
        body: "回复的回复",
        parentId: replyBody.comment.id,
      }),
      { params: Promise.resolve({ slug: SLUG }) },
    );

    expect(tooDeep.status).toBe(400);
    expect(await prisma.comment.count()).toBe(2);
  });

  it("回复一个不存在的父评论返回 404", async () => {
    await seedAsset();
    const user = await seedUser("orphan@example.com");

    const response = await postComment(
      authed(user.token, "http://localhost/api/assets/comment-skill/comments", {
        body: "回复",
        parentId: "not-a-real-comment",
      }),
      { params: Promise.resolve({ slug: SLUG }) },
    );

    expect(response.status).toBe(404);
  });
});

describe("关键词自动过滤", () => {
  it("命中过滤词的评论被拦下，给出明确提示，且不公开", async () => {
    await seedAsset();
    const user = await seedUser("spammer@example.com");

    const response = await postComment(
      authed(user.token, "http://localhost/api/assets/comment-skill/comments", {
        body: "需要资料加微信详聊",
      }),
      { params: Promise.resolve({ slug: SLUG }) },
    );

    expect(response.status).toBe(422);

    const payload = (await response.json()) as { error: string; message: string };
    expect(payload.error).toBe("content_filtered");
    expect(payload.message).toContain("关键词");

    // 落库但不公开：状态是待抽查，公开列表里看不到。
    const rows = await prisma.comment.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("PENDING");
    expect(rows[0].filteredReason).toBe("加微信");

    const listed = await listComments(new Request("http://localhost/api/assets/x/comments"), {
      params: Promise.resolve({ slug: SLUG }),
    });
    const body = (await listed.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(0);
  });

  it("正常评论不被误伤", async () => {
    await seedAsset();
    const user = await seedUser("normal@example.com");

    const response = await postComment(
      authed(user.token, "http://localhost/api/assets/comment-skill/comments", {
        body: "这个 Skill 处理 PDF 很好用，Docker compose 怎么配代理？",
      }),
      { params: Promise.resolve({ slug: SLUG }) },
    );

    expect(response.status).toBe(201);
    const rows = await prisma.comment.findMany();
    expect(rows[0].status).toBe("VISIBLE");
    expect(rows[0].filteredReason).toBeNull();
  });
});

describe("评论正文的 HTML 消毒", () => {
  it("脚本标签被转义，不会变成可执行标记", async () => {
    await seedAsset();
    const user = await seedUser("xss@example.com");

    await postComment(
      authed(user.token, "http://localhost/api/assets/comment-skill/comments", {
        body: "<script>alert(1)</script>",
      }),
      { params: Promise.resolve({ slug: SLUG }) },
    );

    const listed = await listComments(new Request("http://localhost/api/assets/x/comments"), {
      params: Promise.resolve({ slug: SLUG }),
    });
    const payload = (await listed.json()) as { items: { body: string }[] };

    expect(payload.items[0].body).not.toContain("<script");
    expect(payload.items[0].body).toContain("&lt;script&gt;");
  });
});

describe("评论列表", () => {
  it("被隐藏的评论不出现，父评论被隐藏时它的回复也不出现", async () => {
    await seedAsset();
    const user = await seedUser("hidden@example.com");

    const top = await postComment(
      authed(user.token, "http://localhost/api/assets/comment-skill/comments", { body: "将被隐藏" }),
      { params: Promise.resolve({ slug: SLUG }) },
    );
    const topBody = (await top.json()) as { comment: { id: string } };

    await postComment(
      authed(user.token, "http://localhost/api/assets/comment-skill/comments", {
        body: "跟着一起隐藏",
        parentId: topBody.comment.id,
      }),
      { params: Promise.resolve({ slug: SLUG }) },
    );

    await prisma.comment.update({
      where: { id: topBody.comment.id },
      data: { status: "HIDDEN" },
    });

    const listed = await listComments(new Request("http://localhost/api/assets/x/comments"), {
      params: Promise.resolve({ slug: SLUG }),
    });
    const payload = (await listed.json()) as { items: unknown[] };
    expect(payload.items).toHaveLength(0);
  });

  it("不存在的资产返回 404", async () => {
    const response = await listComments(new Request("http://localhost/api/assets/x/comments"), {
      params: Promise.resolve({ slug: "nope" }),
    });

    expect(response.status).toBe(404);
  });
});
