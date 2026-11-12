/**
 * 极简 glob 匹配（票 #15）。
 *
 * ## 为什么自己写
 *
 * 项目**不许新增运行时依赖**，而「按路径匹配一组模式」在两处都要用：
 *   - 许可证 override 的 `appliesTo`（哪些文件适用某个许可）；
 *   - 采集源的路径清单（`examples/training/**` + `/validation*.json`）。
 *
 * 只需要三个通配符，完整 glob（`{a,b}`、`[a-z]`、extglob）用不上。
 *
 * ## 支持的语法
 *
 * | 写法 | 含义 |
 * | --- | --- |
 * | `**` | 任意多个字符（**含** `/`） |
 * | `**` 后跟一个斜杠 | 零个或多个目录层级（`a/**` + `/b` 同时匹配 `a/b` 与 `a/x/y/b`） |
 * | `*` | 任意多个字符（**不含** `/`） |
 * | `?` | 恰好一个字符（不含 `/`） |
 * | 其它 | 按字面量匹配（正则元字符会被转义） |
 */

/** 把 glob 模式编译成正则。 */
export function globToRegExp(pattern: string): RegExp {
  let out = "";

  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];

    if (char === "*") {
      if (pattern[i + 1] === "*") {
        i += 1;
        if (pattern[i + 1] === "/") {
          // `**/` —— 零个或多个目录层级。
          i += 1;
          out += "(?:[^/]+/)*";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      out += "[^/]";
      continue;
    }

    // 其余字符按字面量处理：正则元字符必须转义，
    // 否则用户给的路径里一个 `.` 就能匹配任意字符。
    out += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  return new RegExp(`^${out}$`);
}

/** 路径是否匹配这个 glob 模式。 */
export function matchesGlob(path: string, pattern: string): boolean {
  return globToRegExp(pattern).test(path);
}

/**
 * 路径是否匹配一组模式（任一命中即可）。
 *
 * 路径会先去掉开头的 `./` 与 `/` —— 仓库内相对路径不该带这些前缀，
 * 但上游的清单里两种写法都出现过。
 */
export function matchesAnyGlob(path: string, patterns: readonly string[]): boolean {
  const normalized = normalizeRepoPath(path);
  return patterns.some((pattern) => matchesGlob(normalized, pattern));
}

/** 仓库内相对路径的归一化：去 `./` 前缀、去首尾斜杠。 */
export function normalizeRepoPath(path: string): string {
  let normalized = path.trim().replace(/^\.\//, "");
  while (normalized.startsWith("/")) {
    normalized = normalized.slice(1);
  }
  return normalized;
}
