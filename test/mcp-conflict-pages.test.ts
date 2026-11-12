/**
 * MCP 冲突检测的 HTTP 边界（票 #14）。
 *
 * 详情页与详情接口跑在**真实测试 Postgres** 上（不用内存替身）：
 *
 *   - 登录用户已接入的 server 声明了**同名环境变量** → 页面给出冲突提示；
 *   - 声明了**同一个端口** → 页面给出端口冲突提示；
 *   - 两者都撞 → 两类冲突一起展示；
 *   - 没有冲突 → **不展示**冲突区域（不制造噪音）；
 *   - 游客态 → 不展示（游客没有账号，也就没有已接入集合）。
 *
 * 数据通过 #3 的写入路径（writeAsset）落库 —— 与生产链路一致；
 * 「已接入」记录走 `UserInstall` 表（站内记录的已接入列表）。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** 伪造 next/headers 的 cookies()：测试里自己控制登录态。 */
const { cookieStore } = vi.hoisted(() => ({
  cookieStore: { tokens: new Map<string, string>() },
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieStore.tokens.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));

import { GET as getMcp } from "@/app/api/mcp/[slug]/route";
import McpDetailPage from "@/app/mcp/[slug]/page";
import { writeAsset } from "@/lib/asset-writer";
import { prisma } from "@/lib/prisma";
import { createSession, SESSION_COOKIE } from "@/lib/session";

/** 冲突区域的标题（页面与测试用它对齐「有没有展示冲突」）。 */
const CONFLICT_HEADING = "安装前冲突提示";

/** 候选 server：声明 GCS_BUCKET / SHARED_TOKEN，占 3000 端口。 */
async function seedCandidate(): Promise<string> {
  const asset = await writeAsset({
    kind: "MCP",
    slug: "candidate-mcp",
    displayName: "候选 MCP Server",
    license: null,
    summaryZh: "准备接入的 MCP server。",
    summarySource: "TEMPLATE",
    detail: {
      mcp: {
        transport: "stdio",
        serverName: "com.example/candidate",
        packages: [
          {
            registryType: "npm",
            identifier: "candidate-mcp",
            version: "1.0.0",
            runtimeHint: "npx",
            transport: { type: "stdio" },
            environmentVariables: [
              { name: "GCS_BUCKET", isRequired: true },
              { name: "SHARED_TOKEN" },
            ],
          },
        ],
        remotes: [],
        tools: [],
        envVars: ["GCS_BUCKET", "SHARED_TOKEN"],
        ports: [3000],
        configJson: {
          "com.example/candidate": { command: "npx", args: ["-y", "candidate-mcp"] },
        },
      },
    },
  });
  return asset.id;
}

/**
 * 写一个「已接入」的 MCP server，并登记到某个用户的安装清单里。
 *
 * @param envVars 声明的环境变量名。
 * @param ports 声明的端口。
 */
async function seedInstalled(
  userId: string,
  input: { envVars: string[]; ports: number[] },
): Promise<string> {
  const asset = await writeAsset({
    kind: "MCP",
    slug: "installed-mcp",
    displayName: "已接入的 MCP Server",
    license: null,
    summaryZh: "用户已经接入的 MCP server。",
    summarySource: "TEMPLATE",
    detail: {
      mcp: {
        transport: "stdio",
        serverName: "com.example/installed",
        packages: [],
        remotes: [],
        tools: [],
        envVars: input.envVars,
        ports: input.ports,
        configJson: {
          "com.example/installed": { command: "npx", args: ["-y", "installed-mcp"] },
        },
      },
    },
  });

  await prisma.userInstall.create({
    data: { userId, assetId: asset.id, host: "claude-code" },
  });

  return asset.id;
}

/** 造一个登录用户并把会话 cookie 放进伪造的 cookie store。 */
async function login(email: string): Promise<string> {
  const user = await prisma.user.create({
    data: { email, emailVerifiedAt: new Date() },
  });
  const { token } = await createSession({ userId: user.id });
  cookieStore.tokens.set(SESSION_COOKIE, token);
  return user.id;
}

/** 渲染 MCP 详情页。 */
async function renderDetailPage(): Promise<string> {
  const element = await McpDetailPage({ params: Promise.resolve({ slug: "candidate-mcp" }) });
  return renderToStaticMarkup(element);
}

beforeEach(() => {
  cookieStore.tokens.clear();
});

afterEach(() => {
  cookieStore.tokens.clear();
});

describe("MCP 详情页的安装前冲突提示", () => {
  it("已装 server 声明同名环境变量 → 明确提示变量名与冲突来源", async () => {
    await seedCandidate();
    const userId = await login("env-conflict@example.com");
    await seedInstalled(userId, { envVars: ["GCS_BUCKET"], ports: [4000] });

    const html = await renderDetailPage();

    expect(html).toContain(CONFLICT_HEADING);
    expect(html).toContain("GCS_BUCKET");
    expect(html).toContain("已接入的 MCP Server");
    // 说清是「环境变量」这一类冲突。
    expect(html).toContain("环境变量");
    // SHARED_TOKEN 没撞 —— 冲突描述里不该出现它（页面的环境变量清单里出现是正常的）。
    expect(html).not.toContain("SHARED_TOKEN 与");
  });

  it("已装 server 声明同一端口 → 明确提示端口号与冲突来源", async () => {
    await seedCandidate();
    const userId = await login("port-conflict@example.com");
    await seedInstalled(userId, { envVars: ["OTHER_TOKEN"], ports: [3000] });

    const html = await renderDetailPage();

    expect(html).toContain(CONFLICT_HEADING);
    expect(html).toContain("端口");
    expect(html).toContain("3000");
    expect(html).toContain("已接入的 MCP Server");
    // 变量没撞 —— 不该报环境变量冲突。
    expect(html).not.toContain("GCS_BUCKET 与");
  });

  it("两类都撞 → 环境变量与端口冲突一起展示", async () => {
    await seedCandidate();
    const userId = await login("both-conflict@example.com");
    await seedInstalled(userId, { envVars: ["GCS_BUCKET"], ports: [3000] });

    const html = await renderDetailPage();

    expect(html).toContain(CONFLICT_HEADING);
    expect(html).toContain("环境变量");
    expect(html).toContain("GCS_BUCKET");
    expect(html).toContain("端口");
    expect(html).toContain("3000");
  });

  it("没有冲突 → 整块冲突区域都不出现（不制造噪音）", async () => {
    await seedCandidate();
    const userId = await login("no-conflict@example.com");
    await seedInstalled(userId, { envVars: ["OTHER_TOKEN"], ports: [4000] });

    const html = await renderDetailPage();

    expect(html).not.toContain(CONFLICT_HEADING);
    expect(html).not.toContain("冲突");
    // 页面本身照常渲染。
    expect(html).toContain("候选 MCP Server");
  });

  it("游客态 → 没有已接入集合，不展示冲突区域", async () => {
    await seedCandidate();
    const userId = await login("logged-out@example.com");
    await seedInstalled(userId, { envVars: ["GCS_BUCKET"], ports: [3000] });
    // 登出：游客没有账号，也就没有已接入集合。
    cookieStore.tokens.clear();

    const html = await renderDetailPage();

    expect(html).not.toContain(CONFLICT_HEADING);
    expect(html).not.toContain("冲突");
  });

  it("已接入集合只属于本人：别人的安装记录不影响到当前用户", async () => {
    await seedCandidate();
    const otherUserId = await login("other@example.com");
    await seedInstalled(otherUserId, { envVars: ["GCS_BUCKET"], ports: [3000] });

    // 换成另一个账号登录。
    cookieStore.tokens.clear();
    await login("me@example.com");

    const html = await renderDetailPage();

    expect(html).not.toContain(CONFLICT_HEADING);
  });

  it("已接入集合里装的是 Skill → 不参与 MCP 冲突比对", async () => {
    await seedCandidate();
    const userId = await login("skill-install@example.com");

    const skill = await writeAsset({
      kind: "SKILL",
      slug: "installed-skill",
      displayName: "已接入的 Skill",
      license: "MIT",
      summaryZh: "已接入的 Skill。",
      summarySource: "TEMPLATE",
    });
    await prisma.userInstall.create({
      data: { userId, assetId: skill.id, host: "claude-code" },
    });

    const html = await renderDetailPage();

    expect(html).not.toContain(CONFLICT_HEADING);
  });
});

describe("GET /api/mcp/{slug} 的冲突项", () => {
  it("登录用户：接口返回与页面同口径的冲突项", async () => {
    await seedCandidate();
    const userId = await login("api-conflict@example.com");
    await seedInstalled(userId, { envVars: ["GCS_BUCKET"], ports: [3000] });

    const token = cookieStore.tokens.get(SESSION_COOKIE) ?? "";
    const response = await getMcp(
      new Request("http://localhost/api/mcp/candidate-mcp", {
        headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
      }),
      { params: Promise.resolve({ slug: "candidate-mcp" }) },
    );

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.conflicts).toEqual([
      expect.objectContaining({ kind: "ENV_VAR", name: "GCS_BUCKET" }),
      expect.objectContaining({ kind: "PORT", port: 3000 }),
    ]);
  });

  it("游客态：接口返回空冲突列表", async () => {
    await seedCandidate();
    const userId = await login("api-guest@example.com");
    await seedInstalled(userId, { envVars: ["GCS_BUCKET"], ports: [3000] });

    const response = await getMcp(new Request("http://localhost/api/mcp/candidate-mcp"), {
      params: Promise.resolve({ slug: "candidate-mcp" }),
    });

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.conflicts).toEqual([]);
  });
});
