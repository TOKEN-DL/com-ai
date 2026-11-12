/**
 * 许可证 override（票 #15）。
 *
 * ## 为什么要 override
 *
 * GitHub 的 `license.spdx_id` 来自**仓库根目录 LICENSE 文件的机器识别**，
 * 认不出下面两种情况，一律返回 `NOASSERTION`：
 *
 *   1. **一仓两许可** —— `f/prompts.chat` 的 LICENSE 是一段双许可说明：
 *      prompt 内容（`prompts.csv` / `PROMPTS.md`）是 CC0 1.0，源码是 MIT。
 *      只给仓库一个 SPDX，两边必然判错其中一边。
 *   2. **Markdown 结构的许可声明** —— `YouMind-OpenLab/awesome-seedance-2-prompts`
 *      的 LICENSE 就是标准 CC BY 4.0 全文，GitHub 仍未识别。
 *
 * 照默认路径实现，这两个源（2,897 + 106 条）会全部掉进 METADATA_ONLY，
 * 整个票就没有正文了。
 *
 * ## 粒度：仓库级 + 文件级
 *
 * override 表（`LicenseOverride`）的 `appliesTo` 是一个**路径列表**：
 *   - 空数组 = **仓库级**（整个仓库都是这个许可）；
 *   - 非空 = **文件级**（只覆盖列出的路径，支持 `**` / `*` 通配）。
 *
 * 同仓不同文件不同许可 → 两条记录；匹配时**文件级优先于仓库级**
 * （更具体的那条胜出）。
 *
 * ## 生效路径（**不要改触发器**）
 *
 * 触发器 `comai_apply_content_tier` 只认 `Asset.license` 这一列。
 * 所以 override 的生效方式是：**采集时按本表决定该资产写什么 `license` 值**，
 * 由触发器据此推导 `contentTier`，再由 `contentTier` 决定 `promptBody` 能不能存。
 *
 * 这也让「有没有 override」成为一条可测的因果链：
 * 不 override → `NOASSERTION` → METADATA_ONLY → 正文不入库；
 * override → `cc0-1.0` → FULL → 正文入库。
 */
import { normalizeSpdxId } from "@/lib/license-tier";
import { matchesAnyGlob, normalizeRepoPath } from "@/lib/glob";
import { prisma } from "@/lib/prisma";

/** override 表的一行（与 Prisma 模型同形，但不依赖生成的 client 类型）。 */
export type LicenseOverrideRow = {
  id: string;
  repoSlug: string;
  spdxId: string;
  appliesTo: string[];
  evidence: string | null;
  attribution: string | null;
  note: string | null;
};

/** 命中方式。 */
export type LicenseMatchKind =
  /** 命中了文件级 override（`appliesTo` 非空）。 */
  | "file"
  /** 命中了仓库级 override（`appliesTo` 为空）。 */
  | "repo"
  /** 没有 override，用上游自己声明的许可证（可能是 NOASSERTION / null）。 */
  | "detected";

/** override 解析的结果。 */
export type LicenseResolution = {
  /**
   * 最终写入 `Asset.license` 的值（归一化后的小写 SPDX id）。
   *
   * `null` = 未声明许可证 → 落 METADATA_ONLY 档（正文不入库）。
   */
  spdxId: string | null;
  /** 署名文本（override 带来的；CC BY 4.0 之类必须展示）。 */
  attribution: string | null;
  /** 命中的 override id；没命中是 null。 */
  matchedId: string | null;
  /** 命中方式。 */
  match: LicenseMatchKind;
};

/**
 * override 的确定性 id。
 *
 * 由「仓库 + SPDX + 适用路径」派生（适用路径先排序再拼），
 * 所以：
 *   - 迁移里的种子数据可以幂等重放（`ON CONFLICT (id) DO NOTHING`）；
 *   - 不会出现「应用层算出来的 id 与库里对不上」的漂移 ——
 *     一致性由 test/prompt-license-override.test.ts 盯着。
 */
export function licenseOverrideId(
  repoSlug: string,
  spdxId: string,
  appliesTo: readonly string[],
): string {
  const scope = [...appliesTo]
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0)
    .sort()
    .join(",");
  return `${repoSlug.trim()}::${spdxId.trim()}::${scope}`;
}

/**
 * 模式的「具体程度」：越具体越优先。
 *
 * - 不含通配符的**精确路径**最具体（1000 + 路径长度）；
 * - 含通配符的按模式长度排序（长的一般更具体）。
 */
function specificity(pattern: string): number {
  if (!/[*?]/.test(pattern)) {
    return 1000 + pattern.length;
  }
  return pattern.length;
}

/**
 * 解析一个资产最终该用哪个许可证。
 *
 * 匹配顺序：
 *   1. **文件级**：override 的 `appliesTo` 命中这个文件路径 → 用它
 *      （同仓多条命中时取最具体的那条）；
 *   2. **仓库级**：`appliesTo` 为空的 override；
 *   3. **兜底**：上游自己声明的许可证（`detectedSpdxId`）。
 *
 * ⚠️ `detectedSpdxId` 可能是 `NOASSERTION` —— 那是「认不出来」，
 *    不是「明确不允许再分发」。但两者在分档上结果一样（METADATA_ONLY），
 *    所以这里原样传下去，让「有没有 override」的效果一眼可见。
 */
export function resolveLicenseOverride(
  overrides: readonly LicenseOverrideRow[],
  repoSlug: string,
  filePath: string | null,
  detectedSpdxId: string | null,
): LicenseResolution {
  const repo = repoSlug.trim().toLowerCase();
  const rows = overrides.filter((row) => row.repoSlug.trim().toLowerCase() === repo);

  if (rows.length === 0) {
    return {
      spdxId: normalizeSpdxId(detectedSpdxId),
      attribution: null,
      matchedId: null,
      match: "detected",
    };
  }

  // ① 文件级：命中且最具体的一条。
  if (filePath) {
    const normalizedPath = normalizeRepoPath(filePath);
    const fileMatches = rows
      .filter(
        (row) =>
          row.appliesTo.length > 0 &&
          matchesAnyGlob(normalizedPath, row.appliesTo.map(normalizeRepoPath)),
      )
      .sort((a, b) => {
        const bySpecificity = maxSpecificity(b) - maxSpecificity(a);
        // 同具体程度时按 id 排序，保证结果稳定可复现。
        return bySpecificity !== 0 ? bySpecificity : a.id.localeCompare(b.id);
      });

    const best = fileMatches[0];
    if (best) {
      return {
        spdxId: normalizeSpdxId(best.spdxId),
        attribution: best.attribution,
        matchedId: best.id,
        match: "file",
      };
    }
  }

  // ② 仓库级：`appliesTo` 为空的那条。
  const repoLevel = rows.filter((row) => row.appliesTo.length === 0);
  const repoBest = repoLevel[0];
  if (repoBest) {
    return {
      spdxId: normalizeSpdxId(repoBest.spdxId),
      attribution: repoBest.attribution,
      matchedId: repoBest.id,
      match: "repo",
    };
  }

  // ③ 有文件级规则但这个文件没命中，且没有仓库级规则 → 回到上游声明。
  return {
    spdxId: normalizeSpdxId(detectedSpdxId),
    attribution: null,
    matchedId: null,
    match: "detected",
  };
}

/** 一行 override 里最具体的那个模式的具体程度。 */
function maxSpecificity(row: LicenseOverrideRow): number {
  return row.appliesTo.reduce((max, pattern) => Math.max(max, specificity(pattern)), 0);
}

/**
 * 读出整张 override 表。
 *
 * 采集器默认走这个（override 是**数据**，不是代码常量 ——
 * 运营要能自己加一条，不用发版）。
 */
export async function loadLicenseOverrides(): Promise<LicenseOverrideRow[]> {
  const rows = await prisma.licenseOverride.findMany({ orderBy: { id: "asc" } });
  return rows.map((row) => ({
    id: row.id,
    repoSlug: row.repoSlug,
    spdxId: row.spdxId,
    appliesTo: row.appliesTo,
    evidence: row.evidence,
    attribution: row.attribution,
    note: row.note,
  }));
}
