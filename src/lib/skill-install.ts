/**
 * 「一键复制安装命令」的宿主清单与命令生成。
 *
 * 命令形态参考 `TOKEN-DL/agent-skills-zh` 的多宿主安装指南（docs/ 下的 12 种宿主指南），
 * 底层用开源的 `skills` CLI（vercel-labs/skills）：
 *
 *     npx skills add {owner}/{repo} --skill {skill} -a {agent}
 *
 * `-a/--agent` 决定装到哪个宿主的目录；不带 `-a` 时 CLI 会自动探测已安装的 Agent。
 * 各宿主的安装目录来自 skills CLI 的 `docs/agents.md`（实测清单）。
 *
 * 这里只生成命令，不执行。
 */

export type SkillHostEntry = {
  /// 站内用的宿主标识（落进 SkillDetail.hosts）。
  host: string;
  /// `skills` CLI 的 `--agent` 取值。
  agent: string;
  /// 页面展示名。
  label: string;
  /// 项目级安装目录。
  path: string;
};

/**
 * 支持的宿主。
 *
 * 取自 agent-skills-zh 覆盖的那批宿主（cursor / codex / gemini-cli / windsurf /
 * opencode / antigravity / copilot）+ Claude Code。
 */
export const SKILL_HOSTS: readonly SkillHostEntry[] = [
  { host: "claude-code", agent: "claude-code", label: "Claude Code", path: ".claude/skills/" },
  { host: "codex", agent: "codex", label: "Codex", path: ".agents/skills/" },
  { host: "cursor", agent: "cursor", label: "Cursor", path: ".agents/skills/" },
  { host: "opencode", agent: "opencode", label: "OpenCode", path: ".agents/skills/" },
  { host: "gemini-cli", agent: "gemini-cli", label: "Gemini CLI", path: ".agents/skills/" },
  { host: "github-copilot", agent: "github-copilot", label: "GitHub Copilot", path: ".agents/skills/" },
  { host: "windsurf", agent: "windsurf", label: "Windsurf", path: ".windsurf/skills/" },
  { host: "antigravity", agent: "antigravity", label: "Antigravity", path: ".agents/skills/" },
] as const;

/**
 * 生成按宿主划分的安装命令。
 *
 * 返回的键就是宿主标识，与 {@link SKILL_HOSTS} 一一对应。
 */
export function buildInstallCommands(params: {
  owner: string;
  repo: string;
  skillName: string;
}): Record<string, string> {
  const source = `${params.owner}/${params.repo}`;
  const commands: Record<string, string> = {};
  for (const entry of SKILL_HOSTS) {
    commands[entry.host] = `npx skills add ${source} --skill ${params.skillName} -a ${entry.agent}`;
  }
  return commands;
}

/** 宿主标识 → 展示信息。 */
export function hostEntry(host: string): SkillHostEntry | undefined {
  return SKILL_HOSTS.find((entry) => entry.host === host);
}
