/**
 * Seam 2 —— HTTP 边界（票 #4 验收标准第 2、3 条）。
 *
 * 路由处理器对着**真实测试 Postgres** 跑（不用内存替身）。
 *
 * 关注两件事：
 *   1. 详情接口返回**安装命令**与**整份 SKILL.md**，且 SKILL.md 与上游逐字一致；
 *   2. 详情接口返回**许可证标识**与**来源仓库链接**。
 *
 * 数据通过 #3 的写入路径（writeAsset）落库 —— 与生产链路一致。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { GET as getSkill } from "@/app/api/skills/[slug]/route";
import { GET as listSkills } from "@/app/api/skills/route";
import { writeAsset } from "@/lib/asset-writer";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "github");

function fixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), "utf8");
}

const SKILL_MD = fixture("skill-find-skills.md");

const INSTALL_CMDS = {
  "claude-code": "npx skills add vercel-labs/skills --skill find-skills -a claude-code",
  codex: "npx skills add vercel-labs/skills --skill find-skills -a codex",
};

async function seedFullTierSkill(): Promise<void> {
  await writeAsset({
    kind: "SKILL",
    slug: "vercel-labs-skills-find-skills",
    displayName: "find-skills",
    license: "MIT",
    contentBody: SKILL_MD,
    summaryZh: "来自 vercel-labs/skills 的 Skill「find-skills」。",
    summarySource: "TEMPLATE",
    repoOwner: "vercel-labs",
    repoName: "skills",
    repoUrl: "https://github.com/vercel-labs/skills",
    upstreamUrl:
      "https://raw.githubusercontent.com/vercel-labs/skills/main/skills/find-skills/SKILL.md",
    sourceId: "github-repo",
    stars: 38277,
    detail: {
      skill: {
        frontmatter: { name: "find-skills", description: "Helps users discover and install agent skills." },
        installCmds: INSTALL_CMDS,
        hosts: Object.keys(INSTALL_CMDS),
        skillPath: "skills/find-skills/SKILL.md",
        extraFiles: [],
      },
    },
  });
}

describe("GET /api/skills/{slug}", () => {
  it("返回安装命令、许可证标识与来源仓库链接", async () => {
    await seedFullTierSkill();

    const response = await getSkill(new Request("http://localhost/api/skills/x"), {
      params: Promise.resolve({ slug: "vercel-labs-skills-find-skills" }),
    });

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.displayName).toBe("find-skills");
    expect(body.license).toBe("mit");
    expect(body.contentTier).toBe("FULL");
    expect(body.repoUrl).toBe("https://github.com/vercel-labs/skills");
    expect(body.repoOwner).toBe("vercel-labs");
    expect(body.repoName).toBe("skills");
    expect(body.heatScore).toBe(0);
    expect(body.stars).toBe(38277);

    expect(body.installCmds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          host: "claude-code",
          label: "Claude Code",
          command: "npx skills add vercel-labs/skills --skill find-skills -a claude-code",
        }),
      ]),
    );
  });

  it("整份 SKILL.md 与上游逐字一致", async () => {
    await seedFullTierSkill();

    const response = await getSkill(new Request("http://localhost/api/skills/x"), {
      params: Promise.resolve({ slug: "vercel-labs-skills-find-skills" }),
    });

    const body = await response.json();
    expect(body.contentAvailable).toBe(true);
    expect(body.contentBody).toBe(SKILL_MD);
    expect(body.contentBody).toBe(fixture("skill-find-skills.md"));
  });

  it("原始描述来自 frontmatter", async () => {
    await seedFullTierSkill();

    const response = await getSkill(new Request("http://localhost/api/skills/x"), {
      params: Promise.resolve({ slug: "vercel-labs-skills-find-skills" }),
    });

    const body = await response.json();
    expect(body.description).toBe("Helps users discover and install agent skills.");
  });

  it("不存在的 slug 返回 404", async () => {
    const response = await getSkill(new Request("http://localhost/api/skills/x"), {
      params: Promise.resolve({ slug: "not-there" }),
    });

    expect(response.status).toBe(404);
  });
});

describe("GET /api/skills/{slug} —— 许可证分层的表现", () => {
  it("METADATA_ONLY 资产：站内不给正文，但保留原仓库链接", async () => {
    await writeAsset({
      kind: "SKILL",
      slug: "anthropics-skills-pdf",
      displayName: "pdf",
      license: null,
      contentBody: SKILL_MD,
      summaryZh: "来自 anthropics/skills 的 Skill「pdf」。",
      summarySource: "TEMPLATE",
      repoOwner: "anthropics",
      repoName: "skills",
      repoUrl: "https://github.com/anthropics/skills",
      upstreamUrl: "https://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/SKILL.md",
      sourceId: "github-repo",
      detail: { skill: { frontmatter: { name: "pdf" }, skillPath: "skills/pdf/SKILL.md" } },
    });

    const response = await getSkill(new Request("http://localhost/api/skills/x"), {
      params: Promise.resolve({ slug: "anthropics-skills-pdf" }),
    });

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.contentTier).toBe("METADATA_ONLY");
    expect(body.contentAvailable).toBe(false);
    expect(body.contentBody).toBeNull();
    expect(body.license).toBeNull();
    expect(body.repoUrl).toBe("https://github.com/anthropics/skills");
    expect(body.upstreamUrl).toBe(
      "https://raw.githubusercontent.com/anthropics/skills/main/skills/pdf/SKILL.md",
    );
  });
});

describe("GET /api/skills", () => {
  it("列出已收录的 Skill", async () => {
    await seedFullTierSkill();

    const response = await listSkills(new Request("http://localhost/api/skills"));

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      slug: "vercel-labs-skills-find-skills",
      displayName: "find-skills",
      license: "mit",
      repoUrl: "https://github.com/vercel-labs/skills",
    });
  });
});
