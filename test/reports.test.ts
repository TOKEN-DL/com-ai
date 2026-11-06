/**
 * 举报与运营入口（票 #10 验收标准第 4、5 条）。
 *
 * Seam 2 —— HTTP 边界：路由处理器对着**真实测试 Postgres** 跑。
 *
 * 关注两件事：
 *   1. 举报落库，并出现在运营入口的待处理列表里；
 *   2. 运营可按时间浏览近期评论用于抽查（非运营角色进不去）。
 */
import { describe, expect, it } from "vitest";

import { GET as opsComments, PATCH as patchOpsComment } from "@/app/api/ops/comments/route";
import { GET as opsReports, PATCH as patchOpsReport } from "@/app/api/ops/reports/route";
import { POST as postReport } from "@/app/api/reports/route";
import { prisma } from "@/lib/prisma";
import { createSession, SESSION_COOKIE } from "@/lib/session";

const SLUG = "report-skill";

async function seedAsset(): Promise<void> {
  await prisma.asset.create({
    data: { kind: "SKILL", slug: SLUG, displayName: "举报用 Skill", license: "MIT" },
  });
}

async function seedUser(
  email: string,
  role: "USER" | "MODERATOR" | "ADMIN" = "USER",
): Promise<{ id: string; token: string }> {
  const user = await prisma.user.create({
    data: { email, emailVerifiedAt: new Date(), role },
  });
  const { token } = await createSession({ userId: user.id });
  return { id: user.id, token };
}

function request(url: string, init: RequestInit & { token?: string } = {}): Request {
  const { token, ...rest } = init;
  return new Request(url, {
    ...rest,
    headers: {
      "content-type": "application/json",
      ...(token ? { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` } : {}),
      ...(rest.headers ?? {}),
    },
  });
}

/** 造一条评论，返回它的 id。 */
async function seedComment(body: string, userId: string): Promise<string> {
  const asset = await prisma.asset.findUniqueOrThrow({ where: { slug: SLUG } });
  const comment = await prisma.comment.create({
    data: { assetId: asset.id, userId, body, status: "VISIBLE" },
  });
  return comment.id;
}

describe("举报落库", () => {
  it("登录用户举报评论，举报落库并记下举报人", async () => {
    await seedAsset();
    const user = await seedUser("reporter@example.com");
    const commentId = await seedComment("违规内容", user.id);

    const response = await postReport(
      request("http://localhost/api/reports", {
        method: "POST",
        body: JSON.stringify({ target: "COMMENT", commentId, reason: "SPAM" }),
        token: user.token,
      }),
    );

    expect(response.status).toBe(201);

    const rows = await prisma.report.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].target).toBe("COMMENT");
    expect(rows[0].commentId).toBe(commentId);
    expect(rows[0].reason).toBe("SPAM");
    expect(rows[0].reporterUserId).toBe(user.id);
    expect(rows[0].status).toBe("OPEN");
  });

  it("游客也能举报（举报人留空）", async () => {
    await seedAsset();
    const user = await seedUser("author@example.com");
    const commentId = await seedComment("游客可见的内容", user.id);

    const response = await postReport(
      request("http://localhost/api/reports", {
        method: "POST",
        body: JSON.stringify({ target: "COMMENT", commentId, reason: "OFFENSIVE" }),
      }),
    );

    expect(response.status).toBe(201);
    const rows = await prisma.report.findMany();
    expect(rows[0].reporterUserId).toBeNull();
  });

  it("举报不存在的评论返回 404", async () => {
    await seedAsset();

    const response = await postReport(
      request("http://localhost/api/reports", {
        method: "POST",
        body: JSON.stringify({ target: "COMMENT", commentId: "nope", reason: "SPAM" }),
      }),
    );

    expect(response.status).toBe(404);
    expect(await prisma.report.count()).toBe(0);
  });

  it("不受支持的举报理由返回 400", async () => {
    await seedAsset();
    const user = await seedUser("badreason@example.com");
    const commentId = await seedComment("内容", user.id);

    const response = await postReport(
      request("http://localhost/api/reports", {
        method: "POST",
        body: JSON.stringify({ target: "COMMENT", commentId, reason: "WHATEVER" }),
        token: user.token,
      }),
    );

    expect(response.status).toBe(400);
    expect(await prisma.report.count()).toBe(0);
  });

  it("同一用户重复举报同一条评论不会产生第二条待处理举报", async () => {
    await seedAsset();
    const user = await seedUser("dup@example.com");
    const commentId = await seedComment("内容", user.id);

    const body = JSON.stringify({ target: "COMMENT", commentId, reason: "SPAM" });

    await postReport(
      request("http://localhost/api/reports", { method: "POST", body, token: user.token }),
    );
    const second = await postReport(
      request("http://localhost/api/reports", { method: "POST", body, token: user.token }),
    );

    expect(second.status).toBe(200);
    expect(await prisma.report.count()).toBe(1);
  });
});

describe("运营入口：待处理举报", () => {
  it("普通用户进不去运营入口", async () => {
    await seedAsset();
    const user = await seedUser("plain@example.com");

    const response = await opsReports(
      request("http://localhost/api/ops/reports", { token: user.token }),
    );

    expect(response.status).toBe(403);
  });

  it("游客进不去运营入口", async () => {
    await seedAsset();

    const response = await opsReports(request("http://localhost/api/ops/reports"));

    expect(response.status).toBe(401);
  });

  it("运营能看到待处理举报", async () => {
    await seedAsset();
    const user = await seedUser("author2@example.com");
    const operator = await seedUser("op@example.com", "MODERATOR");
    const commentId = await seedComment("待举报的内容", user.id);

    await postReport(
      request("http://localhost/api/reports", {
        method: "POST",
        body: JSON.stringify({ target: "COMMENT", commentId, reason: "SPAM", detail: "垃圾广告" }),
        token: user.token,
      }),
    );

    const response = await opsReports(
      request("http://localhost/api/ops/reports", { token: operator.token }),
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      items: { id: string; reason: string; status: string; comment: { body: string } | null }[];
    };
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0].status).toBe("OPEN");
    expect(payload.items[0].reason).toBe("SPAM");
    expect(payload.items[0].comment?.body).toBe("待举报的内容");
  });
});

describe("举报的状态流转", () => {
  it("举报成立 → 评论被隐藏，举报变成 RESOLVED", async () => {
    await seedAsset();
    const user = await seedUser("author3@example.com");
    const operator = await seedUser("op2@example.com", "ADMIN");
    const commentId = await seedComment("违规评论", user.id);

    await postReport(
      request("http://localhost/api/reports", {
        method: "POST",
        body: JSON.stringify({ target: "COMMENT", commentId, reason: "ILLEGAL" }),
        token: user.token,
      }),
    );

    const report = await prisma.report.findFirstOrThrow();

    const response = await patchOpsReport(
      request("http://localhost/api/ops/reports", {
        method: "PATCH",
        body: JSON.stringify({ reportId: report.id, action: "resolve" }),
        token: operator.token,
      }),
    );

    expect(response.status).toBe(200);

    const updated = await prisma.report.findUniqueOrThrow({ where: { id: report.id } });
    expect(updated.status).toBe("RESOLVED");
    expect(updated.resolvedAt).not.toBeNull();

    const comment = await prisma.comment.findUniqueOrThrow({ where: { id: commentId } });
    expect(comment.status).toBe("HIDDEN");
  });

  it("举报不成立 → 评论保持可见，举报变成 DISMISSED", async () => {
    await seedAsset();
    const user = await seedUser("author4@example.com");
    const operator = await seedUser("op3@example.com", "MODERATOR");
    const commentId = await seedComment("正常评论", user.id);

    await postReport(
      request("http://localhost/api/reports", {
        method: "POST",
        body: JSON.stringify({ target: "COMMENT", commentId, reason: "OTHER" }),
        token: user.token,
      }),
    );

    const report = await prisma.report.findFirstOrThrow();

    const response = await patchOpsReport(
      request("http://localhost/api/ops/reports", {
        method: "PATCH",
        body: JSON.stringify({ reportId: report.id, action: "dismiss" }),
        token: operator.token,
      }),
    );

    expect(response.status).toBe(200);

    const updated = await prisma.report.findUniqueOrThrow({ where: { id: report.id } });
    expect(updated.status).toBe("DISMISSED");

    const comment = await prisma.comment.findUniqueOrThrow({ where: { id: commentId } });
    expect(comment.status).toBe("VISIBLE");
  });
});

describe("运营抽查：按时间浏览近期评论", () => {
  it("普通用户进不去抽查入口", async () => {
    await seedAsset();
    const user = await seedUser("plain2@example.com");

    const response = await opsComments(
      request("http://localhost/api/ops/comments", { token: user.token }),
    );

    expect(response.status).toBe(403);
  });

  it("按时间窗口浏览：窗口外的评论不出现", async () => {
    await seedAsset();
    const user = await seedUser("author5@example.com");
    const operator = await seedUser("op4@example.com", "MODERATOR");

    const recent = await seedComment("最近评论", user.id);
    const old = await seedComment("很久以前的评论", user.id);

    // 把 old 挪到 25 天前（刻意留出余量，避开窗口边界的毫秒级抖动）。
    await prisma.comment.update({
      where: { id: old },
      data: { createdAt: new Date(Date.now() - 25 * 24 * 60 * 60 * 1000) },
    });

    const within7 = await opsComments(
      request("http://localhost/api/ops/comments?days=7", { token: operator.token }),
    );
    expect(within7.status).toBe(200);
    const sevenDayItems = (await within7.json()) as { items: { id: string }[] };
    expect(sevenDayItems.items.map((item) => item.id)).toEqual([recent]);

    const within30 = await opsComments(
      request("http://localhost/api/ops/comments?days=30", { token: operator.token }),
    );
    const thirtyDayItems = (await within30.json()) as { items: { id: string }[] };
    expect(thirtyDayItems.items.map((item) => item.id).sort()).toEqual([recent, old].sort());
  });

  it("待抽查（命中过滤词）的评论也在抽查列表里，带上命中原因", async () => {
    await seedAsset();
    const user = await seedUser("author6@example.com");
    const operator = await seedUser("op5@example.com", "ADMIN");

    const asset = await prisma.asset.findUniqueOrThrow({ where: { slug: SLUG } });
    await prisma.comment.create({
      data: {
        assetId: asset.id,
        userId: user.id,
        body: "需要资料加微信",
        status: "PENDING",
        filteredReason: "加微信",
      },
    });

    const response = await opsComments(
      request("http://localhost/api/ops/comments?days=7", { token: operator.token }),
    );

    const payload = (await response.json()) as {
      items: { status: string; filteredReason: string | null }[];
    };
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0].status).toBe("PENDING");
    expect(payload.items[0].filteredReason).toBe("加微信");
  });

  it("运营可以把待抽查的评论放行", async () => {
    await seedAsset();
    const user = await seedUser("author7@example.com");
    const operator = await seedUser("op6@example.com", "MODERATOR");
    const commentId = await seedComment("待放行", user.id);

    await prisma.comment.update({
      where: { id: commentId },
      data: { status: "PENDING", filteredReason: "代开发票" },
    });

    const response = await patchOpsComment(
      request("http://localhost/api/ops/comments", {
        method: "PATCH",
        body: JSON.stringify({ commentId, action: "approve" }),
        token: operator.token,
      }),
    );

    expect(response.status).toBe(200);
    const comment = await prisma.comment.findUniqueOrThrow({ where: { id: commentId } });
    expect(comment.status).toBe("VISIBLE");
  });

  it("运营可以隐藏一条评论", async () => {
    await seedAsset();
    const user = await seedUser("author8@example.com");
    const operator = await seedUser("op7@example.com", "ADMIN");
    const commentId = await seedComment("要隐藏", user.id);

    const response = await patchOpsComment(
      request("http://localhost/api/ops/comments", {
        method: "PATCH",
        body: JSON.stringify({ commentId, action: "hide" }),
        token: operator.token,
      }),
    );

    expect(response.status).toBe(200);
    const comment = await prisma.comment.findUniqueOrThrow({ where: { id: commentId } });
    expect(comment.status).toBe("HIDDEN");
  });
});
