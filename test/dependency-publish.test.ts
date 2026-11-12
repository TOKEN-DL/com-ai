/**
 * 依赖声明的发布链路（票 #17）—— HTTP 边界测试。
 *
 * 验的是**外部可观察行为**（真实 Postgres + 真实路由）：
 *   - 发布时给了依赖清单 → 解析入库（依赖表有行、发布记录有快照）；
 *   - 清单格式非法 → 明确报错（带字段路径与行列），**而且没有半截入库**；
 *   - 依赖目标不存在 / 自己依赖自己 / 类型对不上 → 同样明确报错；
 *   - 重新发布时的语义：不带清单 = 不动旧依赖；带空清单 = 解除全部依赖。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST as publishRoute } from "@/app/api/publish/route";
import { writeAsset } from "@/lib/asset-writer";
import { prisma } from "@/lib/prisma";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { setSummaryGenerator, type SummaryDraft, type SummaryGenerator } from "@/lib/summary-generator";

const BODY = "# 我的 Skill\n\n这是 SKILL.md 正文。";

/** 被依赖方（另一个资产）的 slug。 */
const TARGET_SLUG = "pdf-batch-processor";

/** 发布方的 slug（由仓库地址推导：example-my-pdf-skill）。 */
const PUBLISHER_SLUG = "example-my-pdf-skill";

/** 造一个带会话 cookie 的 JSON 请求。 */
function jsonRequest(url: string, body: unknown, token?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) {
    headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
  }
  return new Request(url, { method: "POST", headers, body: JSON.stringify(body) });
}

/** 造一个账号（默认邮箱已验证）。 */
async function createUser(email: string): Promise<{ id: string; token: string }> {
  const user = await prisma.user.create({
    data: { email, emailVerifiedAt: new Date() },
  });
  const { token } = await createSession({ userId: user.id });
  return { id: user.id, token };
}

/** 假的简介生成器（spec 的 port 约定）。 */
function fakeGenerator(): SummaryGenerator {
  return {
    async generate() {
      const draft: SummaryDraft = {
        summaryZh: "AI 写的中文简介。",
        whenToUse: "批量处理 PDF 时使用。",
        howToUse: "安装后直接调用。",
        tags: ["文档处理"],
        source: "LLM",
      };
      return draft;
    },
  };
}

/** 先把被依赖的资产放上平台。 */
async function seedTarget(): Promise<void> {
  await writeAsset({
    kind: "SKILL",
    slug: TARGET_SLUG,
    displayName: "批量处理 PDF 工具",
    license: "MIT",
    summaryZh: "批量处理 PDF 与文档转换的技能。",
    summarySource: "TEMPLATE",
    heatScore: 7,
  });
}

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

/** 合法清单：依赖一个已上架的资产。 */
const VALID_MANIFEST = `
version: 1
dependencies:
  - slug: ${TARGET_SLUG}
    kind: SKILL
    version: ">=1.2.0"
`;

beforeEach(() => {
  setSummaryGenerator(fakeGenerator());
});

afterEach(() => {
  setSummaryGenerator(null);
});

describe("发布时声明依赖", () => {
  it("清单被解析入库：依赖表有行、发布记录有快照与内容 hash", async () => {
    await seedTarget();
    const user = await createUser("publisher@example.com");

    const response = await publishRoute(
      jsonRequest(
        "http://localhost/api/publish",
        publishPayload({
          manifest: VALID_MANIFEST,
          manifestPath: "com-ai.manifest.yaml",
        }),
        user.token,
      ),
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      slug: string;
      dependencies: { slug: string; kind: string; constraint: string | null }[];
    };
    expect(body.slug).toBe(PUBLISHER_SLUG);
    // 接口回显刚落库的依赖关系（版本约束原样展示，不做求解）。
    expect(body.dependencies).toEqual([
      { slug: TARGET_SLUG, displayName: "批量处理 PDF 工具", kind: "SKILL", constraint: ">=1.2.0" },
    ]);

    const publisher = await prisma.asset.findUniqueOrThrow({ where: { slug: PUBLISHER_SLUG } });
    const target = await prisma.asset.findUniqueOrThrow({ where: { slug: TARGET_SLUG } });

    const rows = await prisma.assetDependency.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fromId: publisher.id,
      toId: target.id,
      kind: "SKILL",
      constraint: ">=1.2.0",
    });

    // 发布记录上留了清单快照与内容 hash（#11 预留的两列，#17 起真的被消费）。
    const publication = await prisma.userPublishedAsset.findFirstOrThrow();
    expect(publication.manifestPath).toBe("com-ai.manifest.yaml");
    expect(publication.dependencyManifest).toEqual([
      { slug: TARGET_SLUG, kind: "SKILL", version: ">=1.2.0" },
    ]);
    expect(publication.manifestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("没给清单也能发布（不声明依赖是合法的）", async () => {
    const user = await createUser("publisher@example.com");

    const response = await publishRoute(
      jsonRequest("http://localhost/api/publish", publishPayload(), user.token),
    );

    expect(response.status).toBe(201);
    expect(await prisma.assetDependency.count()).toBe(0);
  });
});

describe("依赖声明不合法 —— 明确报错，不静默忽略", () => {
  it("清单格式非法：400 + 错误里有字段路径与行列位置", async () => {
    const user = await createUser("publisher@example.com");

    const response = await publishRoute(
      jsonRequest(
        "http://localhost/api/publish",
        publishPayload({ manifest: "dependencies:\n  - kind: SKILL\n" }),
        user.token,
      ),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("INVALID_MANIFEST");
    expect(body.message).toContain("dependencies[0].slug");
    expect(body.message).toContain("缺少 slug");
  });

  it("清单格式非法：没有半截入库（资产、依赖、发布记录都没写）", async () => {
    const user = await createUser("publisher@example.com");

    const response = await publishRoute(
      jsonRequest(
        "http://localhost/api/publish",
        publishPayload({ manifest: "dependencies:\n  - slug: 42\n" }),
        user.token,
      ),
    );

    expect(response.status).toBe(400);
    expect(await prisma.asset.count({ where: { slug: PUBLISHER_SLUG } })).toBe(0);
    expect(await prisma.assetDependency.count()).toBe(0);
    expect(await prisma.userPublishedAsset.count()).toBe(0);
  });

  it("依赖目标不存在：400 + 说清楚是哪个目标", async () => {
    const user = await createUser("publisher@example.com");

    const response = await publishRoute(
      jsonRequest(
        "http://localhost/api/publish",
        publishPayload({ manifest: "dependencies:\n  - slug: not-on-platform\n" }),
        user.token,
      ),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("INVALID_DEPENDENCY");
    expect(body.message).toContain("not-on-platform");
    expect(await prisma.asset.count({ where: { slug: PUBLISHER_SLUG } })).toBe(0);
    expect(await prisma.assetDependency.count()).toBe(0);
  });

  it("自己依赖自己：400", async () => {
    const user = await createUser("publisher@example.com");

    const response = await publishRoute(
      jsonRequest(
        "http://localhost/api/publish",
        publishPayload({ manifest: `dependencies:\n  - slug: ${PUBLISHER_SLUG}\n` }),
        user.token,
      ),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("INVALID_DEPENDENCY");
    expect(body.message).toContain("不能依赖自己");
    expect(await prisma.assetDependency.count()).toBe(0);
  });

  it("声明的类型与目标真实类型对不上：400", async () => {
    await seedTarget();
    const user = await createUser("publisher@example.com");

    const response = await publishRoute(
      jsonRequest(
        "http://localhost/api/publish",
        publishPayload({ manifest: `dependencies:\n  - slug: ${TARGET_SLUG}\n    kind: MCP\n` }),
        user.token,
      ),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("INVALID_DEPENDENCY");
    expect(body.message).toContain("类型对不上");
    expect(await prisma.assetDependency.count()).toBe(0);
  });
});

describe("重新发布时的依赖语义", () => {
  it("不带清单重新发布：旧依赖关系保持不变", async () => {
    await seedTarget();
    const user = await createUser("publisher@example.com");

    const first = await publishRoute(
      jsonRequest(
        "http://localhost/api/publish",
        publishPayload({ manifest: VALID_MANIFEST }),
        user.token,
      ),
    );
    expect(first.status).toBe(201);
    expect(await prisma.assetDependency.count()).toBe(1);

    const second = await publishRoute(
      jsonRequest("http://localhost/api/publish", publishPayload(), user.token),
    );
    expect(second.status).toBe(201);

    // 依赖关系没被抹掉。
    expect(await prisma.assetDependency.count()).toBe(1);
  });

  it("带空清单重新发布：依赖关系被解除（清单是完整声明）", async () => {
    await seedTarget();
    const user = await createUser("publisher@example.com");

    await publishRoute(
      jsonRequest(
        "http://localhost/api/publish",
        publishPayload({ manifest: VALID_MANIFEST }),
        user.token,
      ),
    );
    expect(await prisma.assetDependency.count()).toBe(1);

    const second = await publishRoute(
      jsonRequest(
        "http://localhost/api/publish",
        publishPayload({ manifest: "dependencies: []\n" }),
        user.token,
      ),
    );
    expect(second.status).toBe(201);

    expect(await prisma.assetDependency.count()).toBe(0);
    const publication = await prisma.userPublishedAsset.findFirstOrThrow();
    expect(publication.dependencyManifest).toEqual([]);
  });
});
