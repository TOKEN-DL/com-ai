/**
 * MCP registry 条目 → 站内资产 / `mcpServers` 配置片段的**纯函数**层。
 *
 * 这一层不碰网络、不碰数据库：输入是 registry 的原始 JSON，输出是
 * 「传输方式 / 环境变量 / 端口 / 配置片段」。抽成纯函数有两个原因：
 *   1. 配置片段的形状是验收标准（「能直接粘进客户端使用」），必须有单元测试钉住；
 *   2. 详情页要展示同样的信息（环境变量、必填、密钥），页面读的是**入库后的**
 *      结构化字段，与采集时算出来的口径必须一致 —— 同一份纯函数，两处复用。
 *
 * 端点事实（实测，见 .com-ai-context/verified-prompt-mcp.md 第 4 节）：
 *   - `packages` 只有约 14% 的条目有，`remotes` 约 89%，`repository` 约 40%。
 *     **两条路分别建模**（`packages ?? []` / `remotes ?? []`），不假设其一必有。
 *   - `packages[].transport` 是**对象** `{ "type": "stdio" }`，不是字符串。
 *   - `packages[].environmentVariables` / `runtimeArguments` **可能整个不存在**。
 *   - `remotes[].headers` 是**数组**（元素是 KeyValueInput 形状），不是对象字典。
 *   - `remotes[].variables` 的值是**对象**（含 description / isRequired / choices）。
 *   - `identifier` 可能已经出现在 `runtimeArguments` 里（如 `-p @circulara/plugin`），
 *     再无条件追加会生成错误命令 —— 见 {@link buildMcpServersConfig}。
 */

/** registry 的 KeyValueInput：环境变量与请求头共用这个形状。 */
export type McpKeyValueInput = {
  /// 名字（必填）。
  name: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  format?: string;
  default?: string;
  placeholder?: string;
  value?: string;
  variables?: Record<string, McpVariable>;
};

/** URL / 参数里的模板变量声明。 */
export type McpVariable = {
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  choices?: string[];
  default?: string;
};

/** 传输方式。registry 的取值就是这三个。 */
export type McpTransportType = "stdio" | "streamable-http" | "sse";

/** registry 的 Transport：远程 server 与本地包的传输声明。 */
export type McpTransport = {
  type: McpTransportType;
  /// 远程才有。stdio 没有 url。
  url?: string;
  /// 请求头（**数组**，不是对象字典）。
  headers?: McpKeyValueInput[];
  /// URL 模板变量。
  variables?: Record<string, McpVariable>;
};

/** registry 的 Argument：运行器参数与包参数共用。 */
export type McpArgument = {
  /// `positional`（位置参数）/ `named`（带名字的参数）。
  type: "positional" | "named";
  value?: string;
  name?: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  isRepeated?: boolean;
  format?: string;
  default?: string;
  placeholder?: string;
  choices?: string[];
  variables?: Record<string, McpVariable>;
  valueHint?: string;
};

/** registry 的 Package：本地可安装的包声明。 */
export type McpPackage = {
  /// `npm` / `pypi` / `oci` / `mcpb` / `nuget` / `cargo`。
  registryType: string;
  /// 包名（npm / pypi）或镜像地址（oci）。
  identifier: string;
  /// **是对象**：`{ "type": "stdio" }`。
  transport: McpTransport;
  version?: string;
  registryBaseUrl?: string;
  /// 运行器提示（`npx` / `uvx` / `docker` / `node`）。
  runtimeHint?: string;
  /// 传给「运行器」的参数。
  runtimeArguments?: McpArgument[];
  /// 传给「包自己」的参数。
  packageArguments?: McpArgument[];
  /// 该包需要的环境变量。
  environmentVariables?: McpKeyValueInput[];
  fileSha256?: string;
};

/** registry 的 Repository。 */
export type McpRepository = {
  url: string;
  /// `github` / `gitlab` … 只有 github 能换算成 owner/repo。
  source: string;
  subfolder?: string;
  id?: string;
};

/** registry 的 ServerJSON。 */
export type McpServer = {
  /// reverse-DNS 名，恰好一个斜杠。
  name: string;
  description: string;
  title?: string;
  version: string;
  packages?: McpPackage[];
  remotes?: McpTransport[];
  repository?: McpRepository;
  websiteUrl?: string;
  /// server 自己的 `_meta`（发布者提供的扩展信息，例如工具清单）。
  _meta?: Record<string, unknown>;
};

/** registry 列表里的一项。 */
export type McpServerEntry = {
  server: McpServer;
  _meta: Record<string, unknown>;
};

/** 站内展示用的传输方式（`McpDetail.transport` 的取值）。 */
export type McpTransportKind = "stdio" | "http" | "sse" | "unknown";

/** 环境变量清单项。 */
export type McpEnvVar = {
  name: string;
  /// 是否必填（registry 的 isRequired）。
  required: boolean;
  /// 是否是密钥（registry 的 isSecret）。
  secret: boolean;
  description: string | null;
  /// registry 给的默认值（不是凭据，可以原样展示）。
  defaultValue: string | null;
  /// 从哪个包来的（同一个包名可能出现多次）。
  source: string | null;
};

/** 配置片段里「需要用户自己填什么」的一条提示。 */
export type ConfigNote = {
  kind: "secret" | "required" | "variable" | "warning";
  target: string;
  message: string;
};

/** 生成结果：片段本身 + 提示清单。 */
export type BuiltConfig = {
  /// 可直接 JSON.stringify 后粘进客户端的 `mcpServers` 片段。
  mcpServers: Record<string, Record<string, unknown>>;
  /// 给 UI 展示的「你需要自己填什么」清单。
  notes: ConfigNote[];
};

/** 密钥类占位符。**绝不写真实凭据**。 */
export function secretPlaceholder(name: string): string {
  return `<${name}_在这里填你的值>`;
}

/** 必填但没有默认值的占位符。 */
export function requiredPlaceholder(name: string): string {
  return `<${name}>`;
}

/**
 * 把 registry 的 Argument[] 展开成命令行片段。
 *
 * named 参数既没有 value 也没有 default 时填占位符（`<out_值>`）——
 * 填空串会产出缺参数的命令行，粘进客户端直接报错。
 */
function argsToCli(args: McpArgument[] | undefined): string[] {
  const parts: string[] = [];
  for (const arg of args ?? []) {
    if (arg.type === "positional") {
      if (arg.value !== undefined) {
        parts.push(arg.value);
      } else if (arg.name) {
        parts.push(`<${arg.name}>`);
      }
      continue;
    }

    const name = arg.name ?? "";
    if (!name) continue;
    if (arg.value !== undefined) {
      parts.push(name, arg.value);
    } else if (arg.default !== undefined) {
      parts.push(name, arg.default);
    } else {
      parts.push(name, `<${name.replace(/^-+/, "")}_值>`);
    }
  }
  return parts;
}

/** 由 packages[]（本地 stdio / oci）生成配置片段。 */
export function buildFromPackages(pkg: McpPackage, serverName: string): BuiltConfig {
  const notes: ConfigNote[] = [];
  const env: Record<string, string> = {};

  for (const variable of pkg.environmentVariables ?? []) {
    // 绝不写真实密钥：统一用占位符；非密钥项可以带出 default 供参考。
    env[variable.name] = variable.isSecret
      ? secretPlaceholder(variable.name)
      : variable.default !== undefined
        ? variable.default
        : requiredPlaceholder(variable.name);
    notes.push({
      kind: variable.isSecret ? "secret" : "required",
      target: variable.name,
      message: variable.isSecret
        ? `${variable.name} 是密钥（isSecret=true），请从官方渠道获取后填入：${variable.description ?? ""}`
        : `${variable.name}：${variable.description ?? ""}`,
    });
  }

  // runtimeArguments = 给「运行器」的参数；packageArguments = 给「包自己」的参数。
  const identifier = pkg.identifier;
  const args = argsToCli(pkg.runtimeArguments);
  // ⚠️ identifier 可能已经出现在 runtimeArguments 里（实测 `ai.circulara/plugin`：
  //    runtimeArguments = ["-y", "-p", "@circulara/plugin", "circulara-mcp"]，
  //    identifier = "@circulara/plugin"）。再无条件追加会生成
  //    `npx -y -p @circulara/plugin circulara-mcp @circulara/plugin` —— 命令是错的。
  if (!args.includes(identifier)) {
    args.push(identifier);
  }
  args.push(...argsToCli(pkg.packageArguments));

  const command =
    pkg.runtimeHint ??
    (pkg.registryType === "npm"
      ? "npx"
      : pkg.registryType === "pypi"
        ? "uvx"
        : pkg.registryType === "oci"
          ? "docker"
          : undefined);
  if (!command) {
    notes.push({
      kind: "warning",
      target: serverName,
      message: "缺少 runtimeHint，无法自动推断启动命令，请手动填写。",
    });
  }

  const config: Record<string, unknown> = { command: command ?? "npx", args };
  if (Object.keys(env).length > 0) {
    config.env = env;
  }

  if (pkg.runtimeHint === "docker") {
    notes.push({
      kind: "warning",
      target: serverName,
      message:
        "runtimeHint=docker：registry 的 runtimeArguments 不含 `docker run -i --rm` 等样板参数，粘贴前请自行补上。",
    });
  }

  return { mcpServers: { [serverName]: config }, notes };
}

/** 由 remotes[]（远程 server）生成配置片段。 */
export function buildFromRemotes(server: McpServer): BuiltConfig {
  const notes: ConfigNote[] = [];
  const out: Record<string, Record<string, unknown>> = {};

  const remotes = server.remotes ?? [];
  remotes.forEach((remote, index) => {
    const key = remotes.length > 1 ? `${server.name}-${index}` : server.name;

    // URL 模板变量：{api_host} → <api_host>，并把 choices 列进 notes。
    let url = remote.url ?? "";
    for (const [varName, meta] of Object.entries(remote.variables ?? {})) {
      url = url.split(`{${varName}}`).join(`<${varName}>`);
      notes.push({
        kind: meta.isSecret ? "secret" : "variable",
        target: varName,
        message: meta.choices
          ? `URL 变量 ${varName}（可选值：${meta.choices.join(" / ")}）：${meta.description ?? ""}`
          : `URL 变量 ${varName}：${meta.description ?? ""}`,
      });
    }
    // URL 里有 {X} 但 variables 没声明（实测 hapi-mcp 的 {HAPI_FQDN}/{HAPI_PORT} 就是）。
    for (const match of url.matchAll(/\{([^}]+)\}/g)) {
      notes.push({
        kind: "variable",
        target: match[1],
        message: `URL 中的 {${match[1]}} 未在 variables 里声明，请自行确认取值。`,
      });
    }

    const config: Record<string, unknown> = {
      type: remote.type === "sse" ? "sse" : "http",
      url,
    };

    const headers: Record<string, string> = {};
    for (const header of remote.headers ?? []) {
      // header 名大小写混杂（实测 `x-api-key` 与 `X-API-Key` 是两个不同的 header），
      // 所以**不做**大小写不敏感去重。
      headers[header.name] = header.isSecret
        ? secretPlaceholder(header.name)
        : (header.value ?? requiredPlaceholder(header.name));
      notes.push({
        kind: header.isSecret ? "secret" : "required",
        target: header.name,
        message: header.isSecret
          ? `请求头 ${header.name} 是密钥，请填自己的 token：${header.description ?? ""}`
          : `请求头 ${header.name}：${header.description ?? ""}`,
      });
    }
    if (Object.keys(headers).length > 0) {
      config.headers = headers;
    }

    out[key] = config;
  });

  return { mcpServers: out, notes };
}

/**
 * 统一入口：本地包优先；没有 packages 时退回 remotes。
 *
 * ⚠️ 同时有 packages 与 remotes 的条目（约 3%）**两个都出**：客户端的
 *    一个配置项要么是 `command` 要么是 `url`，不能混在一个 key 里，
 *    所以远程那条单独用 `<name>-remote` 的 key。
 */
export function buildMcpServersConfig(entry: McpServerEntry): BuiltConfig {
  const server = entry.server;
  const packages = server.packages ?? [];
  const remotes = server.remotes ?? [];

  const merged: BuiltConfig = { mcpServers: {}, notes: [] };

  packages.forEach((pkg, index) => {
    const key = packages.length > 1 ? `${server.name}-${index}` : server.name;
    const built = buildFromPackages(pkg, key);
    Object.assign(merged.mcpServers, built.mcpServers);
    merged.notes.push(...built.notes);
  });

  if (remotes.length > 0) {
    const built = buildFromRemotes(server);
    if (packages.length > 0) {
      // 本地包已经占了 server.name 这个 key，远程的另起一个。
      for (const [key, value] of Object.entries(built.mcpServers)) {
        merged.mcpServers[`${key}-remote`] = value;
      }
    } else {
      Object.assign(merged.mcpServers, built.mcpServers);
    }
    merged.notes.push(...built.notes);
  }

  return merged;
}

/**
 * 传输方式归类：本地 stdio / 远程 HTTP / 远程 SSE。
 *
 * 本地包优先（有 packages 就是本地可安装的），否则看远程的 transport.type。
 * `streamable-http` 在站内统一叫 `http`（客户端的 `type` 也是这个值）。
 */
export function classifyTransport(entry: McpServerEntry): McpTransportKind {
  for (const pkg of entry.server.packages ?? []) {
    if (pkg.transport?.type === "stdio") {
      return "stdio";
    }
  }
  for (const pkg of entry.server.packages ?? []) {
    if (pkg.transport?.type === "streamable-http" || pkg.transport?.type === "sse") {
      return pkg.transport.type === "sse" ? "sse" : "http";
    }
  }
  for (const remote of entry.server.remotes ?? []) {
    if (remote.type === "sse") return "sse";
    if (remote.type === "streamable-http") return "http";
  }
  return "unknown";
}

/**
 * 环境变量清单。
 *
 * **只收 `packages[].environmentVariables`**：远程 server 的 `headers` 是
 * HTTP 请求头，不是环境变量，混进来会让 #14 的冲突检测报假冲突。
 */
export function collectEnvVars(entry: McpServerEntry): McpEnvVar[] {
  const out: McpEnvVar[] = [];
  const seen = new Set<string>();

  for (const pkg of entry.server.packages ?? []) {
    for (const variable of pkg.environmentVariables ?? []) {
      const key = `${pkg.identifier}#${variable.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        name: variable.name,
        required: variable.isRequired === true,
        secret: variable.isSecret === true,
        description: variable.description ?? null,
        defaultValue: variable.default ?? null,
        source: pkg.identifier,
      });
    }
  }

  return out;
}

/**
 * 声明的端口清单（#14 冲突检测的底座）。
 *
 * 端口只能从**显式带端口的 URL** 里读：本地 stdio 包是子进程，不占端口；
 * 远程 server 的默认端口（80 / 443）也不算「声明的端口」。
 */
export function collectPorts(entry: McpServerEntry): number[] {
  const ports = new Set<number>();

  const addFromUrl = (url: string | undefined): void => {
    if (!url) return;
    try {
      const parsed = new URL(url);
      if (parsed.port) {
        const port = Number.parseInt(parsed.port, 10);
        if (Number.isInteger(port) && port > 0) {
          ports.add(port);
        }
      }
    } catch {
      // URL 里有 registry 的模板变量（`https://{api_host}/mcp`），解析不了就跳过。
    }
  };

  for (const remote of entry.server.remotes ?? []) {
    addFromUrl(remote.url);
  }
  for (const pkg of entry.server.packages ?? []) {
    addFromUrl(pkg.transport?.url);
  }

  return [...ports].sort((a, b) => a - b);
}

/**
 * `repository` → GitHub 的 `owner/repo`。
 *
 * 只有 `source` 是 github（或 URL 确实是 github.com）才这么换；
 * 其它 source（如 gitlab）没有对应的 GitHub 仓库，star 只能是 null。
 */
export function parseGitHubSlug(repository: McpRepository | undefined): string | null {
  if (!repository || typeof repository.url !== "string") {
    return null;
  }
  if (repository.source !== "github") {
    return null;
  }
  const matched = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(repository.url);
  if (!matched) {
    return null;
  }
  return `${matched[1]}/${matched[2]}`;
}

/**
 * registry 的 server 名 → 站内 slug（URL 片段）。
 *
 * registry 的名是 reverse-DNS（`io.github.owner/server`），里面有斜杠与点，
 * 直接当 URL 片段会变成两级路径，所以统一折成连字符。
 */
export function buildMcpSlug(serverName: string): string {
  return serverName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** 上游描述：registry 一定有，但站内 METADATA_ONLY 档位不把它塞进可检索字段。 */
export function readDescription(entry: McpServerEntry): string {
  return entry.server.description ?? "";
}
