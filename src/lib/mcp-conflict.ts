/**
 * MCP 安装前的冲突检测（票 #14）。
 *
 * ## 做什么
 *
 * 候选 server **声明**的环境变量名与端口，跟用户「已接入集合」里各 server
 * 的声明求交集 —— 命中就是冲突。这是**查表比对**（spec 决策 13：
 * 「冲突检测只做查表比对，不做依赖解析器」）。
 *
 * ## 为什么只查表就够
 *
 * 端口与环境变量是**进程级的全局资源**，跟依赖关系无关：
 *
 * - 同一个端口被两个 server 抢 → 后启动的那个直接起不来；
 * - 同名环境变量被两个 server 声明 → 谁后生效谁把另一个的凭据盖掉。
 *
 * 所以「装上去会不会坏」只需要比这两张表，不需要知道谁依赖谁。
 *
 * ## 刻意不做（spec「Out of Scope」：依赖解析与自动求解）
 *
 * - **不做版本求解**：不比较版本号、不判断「装哪个版本能兼容」；
 * - **不做依赖图遍历**：不读 `AssetDependency`、不递归展开依赖；
 * - **不自动改写依赖**：不给替代端口、不给改名建议 —— 只报冲突，怎么解是用户的事。
 *
 * 本模块是**纯函数**：不查库、不读环境变量、不看时钟，同样的输入永远得到同样的输出。
 * 「已接入集合」从哪来是调用方的事（见 {@link ../lib/mcp-install}）。
 */

/** 冲突类型：环境变量同名 / 端口相同。 */
export type McpConflictKind = "ENV_VAR" | "PORT";

/** 一条冲突项。 */
export type McpConflict = {
  /// 冲突的种类。
  kind: McpConflictKind;
  /// 冲突的名字：环境变量名，或端口号的字符串形态（便于直接展示）。
  name: string;
  /// 端口号（只有 `kind = "PORT"` 时有值；环境变量冲突为 null）。
  port: number | null;
  /// 与它冲突的已接入 server（可能不止一个 —— 两个已装 server 抢同一个名字也会撞）。
  servers: { slug: string; displayName: string }[];
};

/** 候选 server 的声明（要比对的那一方）。 */
export type McpConflictCandidate = {
  /// 候选 server 的 slug。用来把**它自己**从已接入集合里排除 ——
  /// 用户已经装过的 server 再看详情页，不该报「和你自己冲突」。
  slug: string;
  /// 候选 server 声明的环境变量名。
  envVars: readonly string[];
  /// 候选 server 声明的端口。
  ports: readonly number[];
};

/** 已接入集合里的一条（MCP server）。 */
export type InstalledMcpServer = {
  /// server 的 slug。
  slug: string;
  /// 展示名。
  displayName: string;
  /// 声明的环境变量名。
  envVars: readonly string[];
  /// 声明的端口。
  ports: readonly number[];
};

/** 端口的合法区间（TCP/UDP 端口号）。 */
const MIN_PORT = 1;
const MAX_PORT = 65535;

/**
 * 环境变量名归一化：去掉首尾空白，空名字丢掉。
 *
 * 空白是数据脏（registry 里手写声明常带空格），空名字比对没有意义。
 *
 * ⚠️ **不做大小写折叠**：环境变量名在 Linux/macOS 上大小写敏感，
 *    `API_KEY` 与 `api_key` 是两个不同的变量，折叠了反而会误报。
 */
function normalizeEnvVarName(raw: string): string | null {
  const name = raw.trim();
  return name.length > 0 ? name : null;
}

/** 端口是不是合法端口号。 */
function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT;
}

/** 一组声明里的环境变量名（去重、去掉空名）。 */
function envVarNames(names: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const raw of names) {
    const name = normalizeEnvVarName(raw);
    if (name !== null) {
      out.add(name);
    }
  }
  return out;
}

/** 一组声明里的端口（去重、只留合法端口）。 */
function ports(values: readonly number[]): Set<number> {
  const out = new Set<number>();
  for (const value of values) {
    if (isValidPort(value)) {
      out.add(value);
    }
  }
  return out;
}

/** 已接入 server 的引用形态（冲突项里只带够展示的信息）。 */
function serverRef(server: InstalledMcpServer): { slug: string; displayName: string } {
  return { slug: server.slug, displayName: server.displayName };
}

/**
 * 冲突检测：候选 server vs 已接入集合 → 冲突项列表。
 *
 * - 环境变量：**同名**即冲突（大小写敏感）；
 * - 端口：**同一个端口号**即冲突；
 * - 两种冲突**可以同时出现**（一个 server 既抢变量名又抢端口）；
 * - 没有冲突时返回**空数组** —— 调用方据此决定「不展示冲突区域」，不制造噪音。
 *
 * 候选 server 自己在已接入集合里时会被跳过（不与自己冲突）。
 */
export function detectMcpConflicts(
  candidate: McpConflictCandidate,
  installed: readonly InstalledMcpServer[],
): McpConflict[] {
  // 自己不跟自己冲突：用户已经装过的 server，详情页不该报冲突。
  const others = installed.filter((server) => server.slug !== candidate.slug);

  const conflicts: McpConflict[] = [];

  for (const name of envVarNames(candidate.envVars)) {
    const servers = others.filter((server) => envVarNames(server.envVars).has(name));
    if (servers.length > 0) {
      conflicts.push({
        kind: "ENV_VAR",
        name,
        port: null,
        servers: servers.map(serverRef),
      });
    }
  }

  for (const port of ports(candidate.ports)) {
    const servers = others.filter((server) => ports(server.ports).has(port));
    if (servers.length > 0) {
      conflicts.push({
        kind: "PORT",
        name: String(port),
        port,
        servers: servers.map(serverRef),
      });
    }
  }

  return conflicts;
}

/**
 * 冲突项的一句话描述（页面与接口共用同一份措辞）。
 *
 * 放在这里而不是页面里：页面与接口要显示**一样的**话，
 * 两边各写一遍文案迟早会漂。
 */
export function describeMcpConflict(conflict: McpConflict): string {
  const names = conflict.servers.map((server) => server.displayName).join("、");
  if (conflict.kind === "ENV_VAR") {
    return `环境变量 ${conflict.name} 与已接入的 ${names} 同名`;
  }
  return `端口 ${conflict.port} 与已接入的 ${names} 相同`;
}
