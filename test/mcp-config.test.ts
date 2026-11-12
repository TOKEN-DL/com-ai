/**
 * MCP 配置片段与结构化字段的**纯函数**单元测试（票 #13）。
 *
 * 验收标准第 3、4 条钉在这里：
 *   - 环境变量清单要标注哪些必填；
 *   - 一键复制出的配置片段能直接粘进客户端使用
 *     （stdio 形态有 command + args，远程形态有 url，env 的值用占位符而不是空串）。
 *
 * ⚠️ 里面有一条**回归用例**：`ai.circulara/plugin` 的 identifier 已经出现在
 *    runtimeArguments 里（`-p @circulara/plugin`），再无条件追加会生成
 *    `npx -y -p @circulara/plugin circulara-mcp @circulara/plugin` —— 命令是错的。
 *    这条用例来自实测（见 .com-ai-context/verified-prompt-mcp.md 第 4.3 / 5.24 节）。
 */
import { describe, expect, it } from "vitest";

import {
  buildFromPackages,
  buildFromRemotes,
  buildMcpServersConfig,
  buildMcpSlug,
  classifyTransport,
  collectEnvVars,
  collectPorts,
  parseGitHubSlug,
  type McpServerEntry,
} from "@/collector/mcp-config";

function entry(server: McpServerEntry["server"], meta?: Record<string, unknown>): McpServerEntry {
  return {
    server,
    _meta: {
      "io.modelcontextprotocol.registry/official": {
        isLatest: true,
        ...(meta ?? {}),
      },
    },
  };
}

describe("mcpServers 配置片段 —— 远程 server", () => {
  it("远程形态是 type + url，能直接粘进客户端", () => {
    const built = buildMcpServersConfig(
      entry({
        name: "ac.inference.sh/mcp",
        description: "d",
        version: "2.0.1",
        remotes: [{ type: "streamable-http", url: "https://api.inference.sh/mcp" }],
      }),
    );

    expect(built.mcpServers).toEqual({
      "ac.inference.sh/mcp": { type: "http", url: "https://api.inference.sh/mcp" },
    });
    // 片段是纯 JSON，JSON.stringify 后就是可直接粘贴的 mcpServers 配置。
    expect(() => JSON.parse(JSON.stringify(built.mcpServers))).not.toThrow();
  });

  it("密钥请求头用占位符，绝不写真 token", () => {
    const built = buildMcpServersConfig(
      entry({
        name: "academy.apexai/apex-ai-academy",
        description: "d",
        version: "1.0.0",
        remotes: [
          {
            type: "streamable-http",
            url: "https://apexai.academy/mcp",
            headers: [{ name: "Authorization", isSecret: true, description: "Bearer <personal key>" }],
          },
        ],
      }),
    );

    const config = built.mcpServers["academy.apexai/apex-ai-academy"];
    expect(config.type).toBe("http");
    expect((config.headers as Record<string, string>).Authorization).toBe(
      "<Authorization_在这里填你的值>",
    );
    // 片段里不能出现任何像是真凭据的长串。
    expect(JSON.stringify(built.mcpServers)).not.toMatch(/Bearer [A-Za-z0-9]{20,}/);
    expect(built.notes.some((note) => note.kind === "secret")).toBe(true);
  });

  it("URL 里的模板变量被换成占位符，choices 进提示", () => {
    const built = buildMcpServersConfig(
      entry({
        name: "ai.autorfp/mcp",
        description: "d",
        version: "1.0.0",
        remotes: [
          {
            type: "streamable-http",
            url: "https://{api_host}/mcp",
            variables: {
              api_host: {
                description: "AutoRFP.ai API host",
                isRequired: true,
                choices: ["api.autorfp.ai", "api.eu.autorfp.ai"],
              },
            },
          },
        ],
      }),
    );

    const config = built.mcpServers["ai.autorfp/mcp"];
    expect(config.url).toBe("https://<api_host>/mcp");
    // 不能把 {api_host} 原样留在 URL 里（客户端会拿到坏 URL）。
    expect(String(config.url)).not.toContain("{api_host}");
    expect(built.notes.some((note) => note.target === "api_host")).toBe(true);
  });

  it("多个 remote 的 key 要加后缀，避免互相覆盖", () => {
    const built = buildFromRemotes({
      name: "io.github.acme/multi",
      description: "d",
      version: "1.0.0",
      remotes: [
        { type: "streamable-http", url: "https://a.example.com/mcp" },
        { type: "sse", url: "https://b.example.com/sse" },
      ],
    });

    expect(Object.keys(built.mcpServers)).toEqual([
      "io.github.acme/multi-0",
      "io.github.acme/multi-1",
    ]);
    expect(built.mcpServers["io.github.acme/multi-1"].type).toBe("sse");
  });
});

describe("mcpServers 配置片段 —— 本地包（stdio）", () => {
  it("stdio 形态是 command + args", () => {
    const built = buildMcpServersConfig(
      entry({
        name: "com.pulsemcp/remote-filesystem",
        description: "d",
        version: "0.1.5",
        packages: [
          {
            registryType: "npm",
            identifier: "remote-filesystem-mcp-server",
            runtimeHint: "npx",
            transport: { type: "stdio" },
            runtimeArguments: [{ type: "positional", value: "-y" }],
          },
        ],
      }),
    );

    const config = built.mcpServers["com.pulsemcp/remote-filesystem"];
    expect(config.command).toBe("npx");
    expect(config.args).toEqual(["-y", "remote-filesystem-mcp-server"]);
  });

  it("没有 runtimeHint 时按 registryType 推断运行器", () => {
    const npm = buildFromPackages(
      { registryType: "npm", identifier: "x", transport: { type: "stdio" } },
      "k",
    );
    expect(npm.mcpServers.k.command).toBe("npx");

    const pypi = buildFromPackages(
      { registryType: "pypi", identifier: "y", transport: { type: "stdio" } },
      "k",
    );
    expect(pypi.mcpServers.k.command).toBe("uvx");

    const oci = buildFromPackages(
      { registryType: "oci", identifier: "docker.io/a/b:1", transport: { type: "stdio" } },
      "k",
    );
    expect(oci.mcpServers.k.command).toBe("docker");
  });

  it("回归：identifier 已经在 runtimeArguments 里时不重复追加", () => {
    const built = buildMcpServersConfig(
      entry({
        name: "ai.circulara/plugin",
        description: "d",
        version: "1.2.0",
        packages: [
          {
            registryType: "npm",
            identifier: "@circulara/plugin",
            runtimeHint: "npx",
            transport: { type: "stdio" },
            runtimeArguments: [
              { type: "positional", value: "-y" },
              { type: "positional", value: "-p" },
              { type: "positional", value: "@circulara/plugin" },
              { type: "positional", value: "circulara-mcp" },
            ],
          },
        ],
      }),
    );

    const config = built.mcpServers["ai.circulara/plugin"];
    expect(config.args).toEqual(["-y", "-p", "@circulara/plugin", "circulara-mcp"]);
    // ⚠️ 这条是最容易写错的地方：多一个包名，命令就跑不通了。
    expect(config.args).not.toContain("@circulara/plugin@circulara/plugin");
    expect((config.args as string[]).filter((arg) => arg === "@circulara/plugin")).toHaveLength(1);
  });

  it("named 运行器参数按「名字 值」展开", () => {
    const built = buildMcpServersConfig(
      entry({
        name: "ai.codenib/codenib",
        description: "d",
        version: "0.2.5",
        packages: [
          {
            registryType: "pypi",
            identifier: "codenib",
            runtimeHint: "uvx",
            transport: { type: "stdio" },
            runtimeArguments: [
              { type: "named", name: "--with", value: "codenib[graph,mcp]==0.2.5" },
            ],
          },
        ],
      }),
    );

    expect(built.mcpServers["ai.codenib/codenib"].args).toEqual([
      "--with",
      "codenib[graph,mcp]==0.2.5",
      "codenib",
    ]);
  });

  it("named 参数既没有值也没有默认值时填占位符，不填空串", () => {
    const built = buildMcpServersConfig(
      entry({
        name: "ai.aquex/stage1",
        description: "d",
        version: "1.0.0",
        packages: [
          {
            registryType: "npm",
            identifier: "@aquex/stage1",
            runtimeHint: "npx",
            transport: { type: "stdio" },
            runtimeArguments: [
              { type: "positional", value: "-y" },
              { type: "named", name: "--out" },
            ],
          },
        ],
      }),
    );

    const args = built.mcpServers["ai.aquex/stage1"].args as string[];
    expect(args).toContain("--out");
    expect(args).toContain("<out_值>");
    // 空串会让客户端少一个参数直接报错。
    expect(args).not.toContain("");
  });

  it("环境变量：密钥用占位符，非密钥带默认值，必填用尖括号占位", () => {
    const built = buildMcpServersConfig(
      entry({
        name: "com.pulsemcp/remote-filesystem",
        description: "d",
        version: "0.1.5",
        packages: [
          {
            registryType: "npm",
            identifier: "remote-filesystem-mcp-server",
            runtimeHint: "npx",
            transport: { type: "stdio" },
            environmentVariables: [
              { name: "GCS_BUCKET", isRequired: true, description: "bucket" },
              { name: "GCS_PRIVATE_KEY", isSecret: true },
              { name: "GCS_MAKE_PUBLIC", default: "false" },
            ],
          },
        ],
      }),
    );

    const env = built.mcpServers["com.pulsemcp/remote-filesystem"].env as Record<string, string>;
    expect(env.GCS_BUCKET).toBe("<GCS_BUCKET>");
    expect(env.GCS_PRIVATE_KEY).toBe("<GCS_PRIVATE_KEY_在这里填你的值>");
    expect(env.GCS_MAKE_PUBLIC).toBe("false");
    // 必填的环境变量不能被省略（客户端会启动失败）。
    expect(Object.keys(env)).toContain("GCS_BUCKET");
    expect(env.GCS_BUCKET).not.toBe("");
  });

  it("docker 运行器要提醒用户补样板参数", () => {
    const built = buildMcpServersConfig(
      entry({
        name: "ai.com.mcp/hapi-mcp",
        description: "d",
        version: "0.6.0",
        packages: [
          {
            registryType: "oci",
            identifier: "docker.io/hapimcp/hapi-cli:0.6.0",
            runtimeHint: "docker",
            transport: { type: "stdio" },
            runtimeArguments: [
              { type: "positional", value: "-p" },
              { type: "positional", value: "3030:3030" },
            ],
          },
        ],
      }),
    );

    expect(built.notes.some((note) => note.kind === "warning")).toBe(true);
    expect(built.notes.some((note) => note.message.includes("docker run"))).toBe(true);
  });

  it("既有 packages 又有 remotes 时两个都出，远程那条另起 key", () => {
    const built = buildMcpServersConfig(
      entry({
        name: "io.github.acme/both",
        description: "d",
        version: "1.0.0",
        packages: [
          {
            registryType: "npm",
            identifier: "both-mcp",
            runtimeHint: "npx",
            transport: { type: "stdio" },
          },
        ],
        remotes: [{ type: "streamable-http", url: "https://both.example.com/mcp" }],
      }),
    );

    expect(built.mcpServers["io.github.acme/both"].command).toBe("npx");
    expect(built.mcpServers["io.github.acme/both-remote"].url).toBe("https://both.example.com/mcp");
  });
});

describe("环境变量清单与必填标记", () => {
  it("必填 / 密钥 / 默认值分别标出来", () => {
    const vars = collectEnvVars(
      entry({
        name: "com.pulsemcp/remote-filesystem",
        description: "d",
        version: "0.1.5",
        packages: [
          {
            registryType: "npm",
            identifier: "remote-filesystem-mcp-server",
            transport: { type: "stdio" },
            environmentVariables: [
              { name: "GCS_BUCKET", isRequired: true, description: "bucket" },
              { name: "GCS_PRIVATE_KEY", isSecret: true },
              { name: "GCS_MAKE_PUBLIC", default: "false" },
              { name: "GCS_PROJECT_ID" },
            ],
          },
        ],
      }),
    );

    const byName = new Map(vars.map((variable) => [variable.name, variable]));
    expect(byName.get("GCS_BUCKET")?.required).toBe(true);
    expect(byName.get("GCS_PRIVATE_KEY")?.secret).toBe(true);
    expect(byName.get("GCS_MAKE_PUBLIC")?.defaultValue).toBe("false");
    // 没声明 isRequired 的就是「非必填」，不能默认当成必填。
    expect(byName.get("GCS_PROJECT_ID")?.required).toBe(false);
    expect(vars).toHaveLength(4);
  });

  it("远程 server 的 HTTP 请求头不算环境变量", () => {
    const vars = collectEnvVars(
      entry({
        name: "academy.apexai/apex-ai-academy",
        description: "d",
        version: "1.0.0",
        remotes: [
          {
            type: "streamable-http",
            url: "https://apexai.academy/mcp",
            headers: [{ name: "Authorization", isSecret: true }],
          },
        ],
      }),
    );

    expect(vars).toEqual([]);
  });
});

describe("传输方式归类", () => {
  it("本地包 → stdio", () => {
    expect(
      classifyTransport(
        entry({
          name: "a/b",
          description: "d",
          version: "1",
          packages: [
            { registryType: "npm", identifier: "x", transport: { type: "stdio" } },
          ],
        }),
      ),
    ).toBe("stdio");
  });

  it("远程 streamable-http → http", () => {
    expect(
      classifyTransport(
        entry({
          name: "a/b",
          description: "d",
          version: "1",
          remotes: [{ type: "streamable-http", url: "https://x/mcp" }],
        }),
      ),
    ).toBe("http");
  });

  it("远程 sse → sse", () => {
    expect(
      classifyTransport(
        entry({
          name: "a/b",
          description: "d",
          version: "1",
          remotes: [{ type: "sse", url: "https://x/sse" }],
        }),
      ),
    ).toBe("sse");
  });

  it("既没有 packages 也没有 remotes → unknown（不猜）", () => {
    expect(
      classifyTransport(entry({ name: "a/b", description: "d", version: "1" })),
    ).toBe("unknown");
  });
});

describe("端口与仓库 slug", () => {
  it("只收显式带端口的 URL，默认端口不算", () => {
    const ports = collectPorts(
      entry({
        name: "a/b",
        description: "d",
        version: "1",
        remotes: [
          { type: "streamable-http", url: "http://localhost:3000/mcp" },
          { type: "streamable-http", url: "https://example.com/mcp" },
          { type: "streamable-http", url: "https://example.com:8443/sse" },
        ],
      }),
    );

    expect(ports).toEqual([3000, 8443]);
  });

  it("本地 stdio 不占端口", () => {
    expect(
      collectPorts(
        entry({
          name: "a/b",
          description: "d",
          version: "1",
          packages: [
            { registryType: "npm", identifier: "x", transport: { type: "stdio" } },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("只有 github 来源的仓库能换算成 owner/repo", () => {
    expect(
      parseGitHubSlug({ url: "https://github.com/pulsemcp/mcp-servers", source: "github" }),
    ).toBe("pulsemcp/mcp-servers");
    expect(
      parseGitHubSlug({ url: "https://github.com/pulsemcp/mcp-servers.git", source: "github" }),
    ).toBe("pulsemcp/mcp-servers");
    expect(
      parseGitHubSlug({ url: "https://gitlab.com/a/b", source: "gitlab" }),
    ).toBeNull();
    expect(parseGitHubSlug(undefined)).toBeNull();
  });

  it("slug 归一化：reverse-DNS 名折成 URL 片段", () => {
    expect(buildMcpSlug("io.github.Digital-Defiance/mcp-filesystem")).toBe(
      "io-github-digital-defiance-mcp-filesystem",
    );
  });
});
